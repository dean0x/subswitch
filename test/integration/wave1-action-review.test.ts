/** Synthetic lifecycle server and real isolated child processes; no native credentials. */
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { runAction } from "../../src/run-action.js";
import { loadConfig } from "../../src/config.js";

async function until(condition: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 3000;
  while (!(await condition())) {
    assert.ok(Date.now() < deadline, "synthetic action fixture timed out");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
async function fixture(
  options: {
    delayCancel?: number;
    delayComplete?: number;
    onComplete?: () => void;
    retainClosing?: boolean;
  } = {},
) {
  const id = randomUUID(),
    capability = "a".repeat(64);
  const calls: string[] = [];
  let active = true;
  const server = http.createServer((req, res) => {
    req.resume();
    res.setHeader("content-type", "application/json");
    assert.equal(req.headers["x-subswitch-capability"], capability);
    if (req.url === "/__subswitch/actions") {
      res.writeHead(201);
      res.end(
        JSON.stringify({
          id,
          ingressPrefix: `/__subswitch/action/${id}/ingress`,
        }),
      );
      return;
    }
    const operation = req.url?.endsWith("/cancel") ? "cancel" : "complete";
    calls.push(operation);
    if (!active) {
      res.writeHead(409);
      res.end('{"error":"action_state_lost"}');
      return;
    }
    if (operation === "cancel" || !options.retainClosing) active = false;
    if (operation === "complete") options.onComplete?.();
    const delay =
      operation === "cancel" ? options.delayCancel : options.delayComplete;
    setTimeout(
      () =>
        res.end(
          JSON.stringify({
            phase: operation === "cancel" ? "cancelled" : "closing",
          }),
        ),
      delay ?? 0,
    );
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error();
  const port = address.port;
  const loaded = loadConfig({
    configPath: "/synthetic/config.json",
    env: {},
    readFile: () => JSON.stringify({ port }),
  });
  if (!loaded.ok) throw new Error(loaded.error.message);
  return {
    config: loaded.value.config,
    calls,
    readControl: async () => ({ port, capability }),
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

describe("Wave 1 native invocation lifecycle reliability", () => {
  it("sends one cancel when signal handling and child exit overlap a delayed control response", async () => {
    const directory = await mkdtemp(join(tmpdir(), "subswitch-action-review-"));
    const ready = join(directory, "ready"),
      controller = new AbortController();
    const rig = await fixture({ delayCancel: 100 });
    const program = `process.on("SIGTERM",()=>process.exit(0)); require("node:fs").writeFileSync(${JSON.stringify(ready)},String(process.pid)); setInterval(()=>{},10000);`;
    try {
      const pending = runAction(
        rig.config,
        "codex",
        [process.execPath, "-e", program],
        "synthetic",
        { readControl: rig.readControl, signal: controller.signal },
      );
      await until(async () => {
        try {
          await readFile(ready);
          return true;
        } catch {
          return false;
        }
      });
      const pid = Number(await readFile(ready, "utf8"));
      controller.abort();
      assert.equal(
        await pending,
        130,
        "cancellation takes precedence even when the child catches SIGTERM and exits zero",
      );
      assert.deepEqual(rig.calls, ["cancel"]);
      assert.throws(
        () => process.kill(pid, 0),
        (error: unknown) => (error as NodeJS.ErrnoException).code === "ESRCH",
      );
    } finally {
      controller.abort();
      await rig.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  for (const code of [0, 7]) {
    it(`preserves native exit ${code} and performs one matching lifecycle operation`, async () => {
      const rig = await fixture({ delayCancel: 30, delayComplete: 30 });
      try {
        assert.equal(
          await runAction(
            rig.config,
            "codex",
            [process.execPath, "-e", `process.exit(${code})`],
            "synthetic",
            { readControl: rig.readControl },
          ),
          code,
        );
        assert.deepEqual(rig.calls, [code === 0 ? "complete" : "cancel"]);
      } finally {
        await rig.close();
      }
    });
  }

  for (const retainClosing of [true, false]) {
    it(`honors cancellation arriving while completion is closing admission (${retainClosing ? "requests remain" : "already finalized"})`, async () => {
      const controller = new AbortController();
      const rig = await fixture({
        delayComplete: 30,
        retainClosing,
        onComplete: () => controller.abort(),
      });
      try {
        assert.equal(
          await runAction(
            rig.config,
            "codex",
            [process.execPath, "-e", "process.exit(0)"],
            "synthetic",
            { readControl: rig.readControl, signal: controller.signal },
          ),
          130,
        );
        assert.deepEqual(rig.calls, ["complete", "cancel"]);
      } finally {
        await rig.close();
      }
    });
  }

  it("cancels a failed spawn once without hiding its original error", async () => {
    const rig = await fixture({ delayCancel: 30 });
    try {
      await assert.rejects(
        runAction(
          rig.config,
          "codex",
          ["/synthetic/nonexistent-native-command"],
          "synthetic",
          { readControl: rig.readControl },
        ),
        (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT",
      );
      assert.deepEqual(rig.calls, ["cancel"]);
    } finally {
      await rig.close();
    }
  });

  it("does not launch a native process for an already cancelled invocation", async () => {
    const controller = new AbortController();
    controller.abort();
    const rig = await fixture();
    try {
      assert.equal(
        await runAction(
          rig.config,
          "codex",
          ["/synthetic/nonexistent-native-command"],
          "synthetic",
          { readControl: rig.readControl, signal: controller.signal },
        ),
        130,
      );
      assert.deepEqual(rig.calls, ["cancel"]);
    } finally {
      await rig.close();
    }
  });

  if (process.platform !== "win32") {
    it("stops descendants in the invocation process group before completing admission", async () => {
      const directory = await mkdtemp(
        join(tmpdir(), "subswitch-action-group-review-"),
      );
      const heartbeat = join(directory, "heartbeat");
      const rig = await fixture();
      const descendant = `const fs=require("node:fs"); fs.writeFileSync(${JSON.stringify(heartbeat)},"0"); let tick=0; setInterval(()=>fs.writeFileSync(${JSON.stringify(heartbeat)},String(++tick)),10);`;
      const parent = `const fs=require("node:fs"); require("node:child_process").spawn(process.execPath,["-e",${JSON.stringify(descendant)}],{stdio:"ignore"}); const timer=setInterval(()=>{if(fs.existsSync(${JSON.stringify(heartbeat)})){clearInterval(timer);process.exit(0);}},5);`;
      try {
        assert.equal(
          await runAction(
            rig.config,
            "codex",
            [process.execPath, "-e", parent],
            "synthetic",
            { readControl: rig.readControl },
          ),
          0,
        );
        const stopped = await readFile(heartbeat, "utf8");
        await new Promise((resolve) => setTimeout(resolve, 75));
        assert.equal(
          await readFile(heartbeat, "utf8"),
          stopped,
          "the descendant must stop before the wrapper returns",
        );
        assert.deepEqual(rig.calls, ["complete"]);
      } finally {
        await rig.close();
        await rm(directory, { recursive: true, force: true });
      }
    });
  }
});
