import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { rawHttpRequest, sseHandler, startFakeUpstream, startSubswitch } from "./fake-upstreams.js";
import { lateToolNames } from "../fixtures/together/streams.js";

const cli = fileURLToPath(new URL("../../src/cli.ts", import.meta.url));
const tsx = fileURLToPath(new URL("../../node_modules/.bin/tsx", import.meta.url));

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "routing-config-trust-"));
  const userPath = join(root, "config", "subswitch", "config.json");
  await mkdir(join(userPath, ".."), { recursive: true });
  return { root, userPath, env: { PATH: process.env.PATH, HOME: root, XDG_CONFIG_HOME: join(root, "config") } };
}

function run(root: string, env: NodeJS.ProcessEnv, args: string[]) {
  return new Promise<{ code: number; stdout: string; stderr: string }>(resolve => {
    execFile(tsx, [cli, ...args], { cwd: root, env, timeout: 10_000, maxBuffer: 64 * 1024 },
      (error, stdout, stderr) => resolve({ code: error ? Number(error.code) || 1 : 0, stdout, stderr }));
  });
}

async function writeControl(root: string, port: number, value: unknown) {
  const path = join(root, ".cache", "subswitch", "actions", String(port), "control.json");
  await mkdir(join(path, ".."), { recursive: true, mode: 0o700 });
  await writeFile(path, JSON.stringify(value), { mode: 0o600 });
}

const native = ["run-action", "--client", "claude-code", "--", process.execPath, "--version"];

describe("CLI routing configuration sources", () => {
  for (const source of ["user", "explicit"] as const) {
    it(`uses the ${source} port for run-action instead of the project port`, { timeout: 15_000 }, async () => {
      const f = await fixture();
      try {
        await writeFile(f.userPath, '{"port":65533}');
        await writeFile(join(f.root, "subswitch.config.json"), '{"port":65534}');
        // Invalid metadata pins the selected port and must stop the native command.
        await writeControl(f.root, 65533, {});
        const result = await run(f.root, { ...f.env, ...(source === "explicit" ? { SUBSWITCH_CONFIG: f.userPath } : {}) }, native);
        assert.equal(result.code, 1);
        assert.match(result.stderr, /invalid_action_control_file/);
        assert.equal(result.stdout, "");
      } finally { await rm(f.root, { recursive: true, force: true }); }
    });
  }

  it("ignores the project port for run-action when the user file is absent", { timeout: 15_000 }, async () => {
    const f = await fixture();
    try {
      await writeFile(join(f.root, "subswitch.config.json"), '{"port":65534}');
      await writeControl(f.root, 65534, {});
      const result = await run(f.root, f.env, native);
      assert.equal(result.code, 0, result.stderr);
      assert.match(result.stdout, /v\d+\./);
    } finally { await rm(f.root, { recursive: true, force: true }); }
  });

  it("reports project routes before it starts a native command", { timeout: 15_000 }, async () => {
    const f = await fixture();
    try {
      await writeFile(join(f.root, "subswitch.config.json"), '{"routes":{}}');
      const result = await run(f.root, f.env, native);
      assert.equal(result.code, 1);
      assert.match(result.stderr, /routes.*not allowed in project configuration/);
      assert.equal(result.stdout, "");
    } finally { await rm(f.root, { recursive: true, force: true }); }
  });
});

describe("Together configuration and host trust", () => {
  const togetherProfile = {
    configVersion: 2,
    accessProfiles: { together: { provider: "together", product: "chatgpt-codex", billing: "subscription", account: "test",
      credential: { kind: "native-oauth", authFile: "/no-auth.json" } } },
    routes: { test: { clients: ["claude-code"], primary: { profile: "together", model: "fixture", effort: "low" } } },
  };
  for (const [label, file, config, error] of [
    ["a user profile and route that name together", "user", togetherProfile, /unsupported provider: together/],
    ["a project providers.together block", "project", { providers: { together: {} } }, /providers\.together not allowed in project configuration/],
  ] as const) {
    it(`refuses ${label} before it starts a native command`, { timeout: 15_000 }, async () => {
      const f = await fixture();
      try {
        await writeFile(file === "user" ? f.userPath : join(f.root, "subswitch.config.json"), JSON.stringify(config));
        const result = await run(f.root, f.env, native);
        assert.equal(result.code, 1);
        assert.match(result.stderr, error);
        assert.equal(result.stdout, "");
      } finally { await rm(f.root, { recursive: true, force: true }); }
    });
  }

  it("refuses a foreign Host or Origin for a Together model before the key load", async (t) => {
    const together = await startFakeUpstream(sseHandler(lateToolNames));
    t.after(together.close);
    const anthropic = await startFakeUpstream((_req, res) => { res.writeHead(418); res.end(); });
    t.after(anthropic.close);
    const exec = t.mock.fn(async (): Promise<{ stdout: string }> => { throw new Error("item not found"); });
    const proxy = await startSubswitch({ anthropic: { baseUrl: anthropic.url }, providers: { together: { baseUrl: `${together.url}/v1` } } },
      { togetherKeyReader: { env: {}, platform: "darwin", exec, setTimer: () => () => {} } });
    t.after(proxy.close);
    const body = Buffer.from(JSON.stringify({ model: "together:fixture/model", max_tokens: 16, messages: [{ role: "user", content: "hi" }] }));
    const send = (headers: string[]) => rawHttpRequest(`${proxy.url}/v1/messages`, {
      method: "POST", rawHeaders: [...headers, "Content-Type", "application/json"], body,
    });

    for (const headers of [["Host", "foreign.invalid"], ["Host", new URL(proxy.url).host, "Origin", "https://foreign.invalid"]]) {
      assert.equal((await send(headers)).status, 403, headers.join(" "));
    }
    assert.equal(exec.mock.callCount() + together.requests.length + anthropic.requests.length, 0);

    // Control: the same request from a loopback client reaches the key load.
    assert.equal((await send([])).status, 401);
    assert.equal(exec.mock.callCount(), 1);
    assert.equal(together.requests.length + anthropic.requests.length, 0);
  });
});
