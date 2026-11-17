/** Synthetic action controls and real children; no live provider calls. */
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { describe, it } from "node:test";
import { loadConfig } from "../../src/config.js";
import { runAction } from "../../src/run-action.js";
import { ActionIngress } from "../../src/routing/action-ingress.js";
import { ActionStore } from "../../src/routing/action-store.js";
import type { RoutingClock } from "../../src/routing/clock.js";

function clockFixture() {
  let now = 0;
  const timers = new Map<() => void, number>();
  const clock: RoutingClock = {
    now: () => now,
    monotonic: () => now,
    random: () => 0.5,
    schedule(callback, delayMs) {
      timers.set(callback, now + delayMs);
      return () => { timers.delete(callback); };
    },
  };
  return {
    clock,
    advance(milliseconds: number) {
      now += milliseconds;
      for (const [callback, deadline] of [...timers]) {
        if (deadline > now) continue;
        timers.delete(callback);
        callback();
      }
    },
    timers,
  };
}

async function fixture(store = new ActionStore()) {
  const ingress = new ActionIngress(store);
  const operations: string[] = [], captured: unknown[] = [];
  let ready!: () => void;
  const readiness = new Promise<void>((resolve) => { ready = resolve; });
  const server = http.createServer(async (req, res) => {
    if (req.url?.endsWith("/ready")) {
      req.resume();
      res.end();
      ready();
    } else if (req.url?.endsWith("/capture")) {
      const parts: Buffer[] = [];
      for await (const part of req) parts.push(part);
      const body: unknown = JSON.parse(Buffer.concat(parts).toString("utf8"));
      captured.push(body);
      res.end();
    } else {
      if (req.url?.endsWith("/cancel")) operations.push("cancel");
      if (req.url?.endsWith("/complete")) operations.push("complete");
      await ingress.control(req, res);
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const port = address.port;
  const loaded = loadConfig({
    configPath: "/synthetic/action-owner.json",
    env: {},
    readFile: () => JSON.stringify({ port }),
  });
  assert.ok(loaded.ok);
  return {
    config: loaded.value.config,
    readControl: async () => ({ port, capability: store.capability }),
    operations,
    captured,
    readiness,
    create(ownerPid: unknown) {
      return fetch(`http://127.0.0.1:${port}/__subswitch/actions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-subswitch-capability": store.capability,
        },
        body: JSON.stringify({
          client: "claude-code", conversationId: "synthetic", ownerPid,
        }),
      });
    },
    async close() {
      store.close();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

const readyProgram = 'fetch(process.env.ANTHROPIC_BASE_URL + "/ready").then(() => new Promise(resolve => setTimeout(resolve, 1000)));';

describe("native action child boundary", () => {
  it("omits every env profile variable and keeps the parent environment intact", async (t) => {
    const values = {
      ACTION_TEST_CODE_KEY: "synthetic-code",
      ACTION_TEST_PLATFORM_KEY: "synthetic-platform",
      ACTION_TEST_KEEP: "synthetic-keep",
    };
    for (const [name, value] of Object.entries(values)) {
      const original = process.env[name];
      process.env[name] = value;
      t.after(() => {
        if (original === undefined) delete process.env[name];
        else process.env[name] = original;
      });
    }
    const rig = await fixture();
    const config = {
      ...rig.config,
      accessProfiles: {
        code: {
          provider: "kimi", product: "kimi-code", billing: "subscription",
          account: "synthetic",
          credential: { kind: "env", name: "ACTION_TEST_CODE_KEY" },
        },
        platform: {
          provider: "kimi", product: "kimi-platform", billing: "api",
          account: "synthetic",
          credential: { kind: "env", name: "ACTION_TEST_PLATFORM_KEY" },
        },
        oauth: {
          provider: "claude", product: "claude-code", billing: "subscription",
          account: "synthetic",
          credential: { kind: "native-oauth", authFile: "/synthetic/auth.json" },
        },
      },
    } satisfies typeof rig.config;
    const program = `fetch(process.env.ANTHROPIC_BASE_URL + "/capture", {method:"POST",body:JSON.stringify({code:process.env.ACTION_TEST_CODE_KEY ?? null,platform:process.env.ACTION_TEST_PLATFORM_KEY ?? null,keep:process.env.ACTION_TEST_KEEP})});`;
    try {
      assert.equal(await runAction(
        config, "claude-code", [process.execPath, "-e", program], "synthetic",
        { readControl: rig.readControl },
      ), 0);
      assert.deepEqual(rig.captured, [
        { code: null, platform: null, keep: "synthetic-keep" },
      ]);
      for (const [name, value] of Object.entries(values))
        assert.equal(process.env[name], value);
    } finally {
      await rig.close();
    }
  });

  it("records the wrapper process as the action owner", async () => {
    const time = clockFixture(), observed: number[] = [];
    const store = new ActionStore(time.clock, (pid) => {
      observed.push(pid);
      return true;
    });
    const rig = await fixture(store), controller = new AbortController();
    const pending = runAction(
      rig.config, "claude-code", [process.execPath, "-e", readyProgram], "synthetic",
      { readControl: rig.readControl, signal: controller.signal },
    );
    try {
      await rig.readiness;
      time.advance(60_000);
      assert.deepEqual(observed, [process.pid]);
    } finally {
      controller.abort();
      await pending;
      await rig.close();
    }
  });

  it("cancels the child and removes its SIGHUP listener when the terminal closes", async () => {
    const rig = await fixture(), controller = new AbortController();
    const before = process.listenerCount("SIGHUP");
    const pending = runAction(
      rig.config, "claude-code", [process.execPath, "-e", readyProgram], "synthetic",
      { readControl: rig.readControl, signal: controller.signal },
    );
    try {
      await rig.readiness;
      process.emit("SIGHUP");
      assert.equal(await pending, 130);
      assert.deepEqual(rig.operations, ["cancel"]);
      assert.equal(process.listenerCount("SIGHUP"), before);
    } finally {
      controller.abort();
      await pending;
      await rig.close();
    }
  });
});

describe("action owner reclamation", () => {
  it("cancels dead owner work but never expires admitted work for a live owner", () => {
    const time = clockFixture(), dead = new Set<number>();
    const store = new ActionStore(time.clock, (pid) => !dead.has(pid));
    const lost = store.create("claude-code", "lost", "explicit", 71);
    const live = store.create("claude-code", "live", "explicit", 72);
    const lostContext = store.context(lost.id, "claude-code");
    const liveContext = store.context(live.id, "claude-code");
    const lostRequest = new AbortController(), liveRequest = new AbortController();
    let lostTransportClosed = false, liveTransportClosed = false;
    const releaseLost = store.admit(lostContext, lostRequest);
    const releaseLive = store.admit(liveContext, liveRequest);
    store.attachTransport(lostContext, () => { lostTransportClosed = true; });
    store.attachTransport(liveContext, () => { liveTransportClosed = true; });
    try {
      dead.add(71);
      time.advance(24 * 60 * 60 * 1000);
      assert.equal(lostRequest.signal.aborted, true);
      assert.equal(lostTransportClosed, true);
      assert.throws(() => store.context(lost.id, "claude-code"), /action_state_lost/);
      assert.equal(liveRequest.signal.aborted, false);
      assert.equal(liveTransportClosed, false);
      assert.deepEqual(store.context(live.id, "claude-code"), liveContext);
      releaseLost();
      releaseLost();
    } finally {
      releaseLive();
      store.close();
    }
    assert.equal(time.timers.size, 0);
  });

  it("restores action capacity before admission when owners die between checks", () => {
    const time = clockFixture();
    let alive = true;
    const store = new ActionStore(time.clock, () => alive);
    try {
      for (let i = 0; i < 4096; i++)
        store.create("claude-code", `lost-${i}`, "explicit", 71);
      assert.throws(
        () => store.create("claude-code", "full", "explicit", 71),
        /action_store_full/,
      );
      alive = false;
      assert.doesNotThrow(() => store.create("claude-code", "replacement", "explicit", 72));
    } finally {
      store.close();
    }
  });

  it("restores affinity capacity even before a dead owner's admitted request releases", () => {
    const time = clockFixture();
    let alive = true;
    const store = new ActionStore(time.clock, (pid) => pid !== 71 || alive);
    const old = store.create("claude-code", "lost", "explicit", 71);
    const context = store.context(old.id, "claude-code"), request = new AbortController();
    const release = store.admit(context, request);
    try {
      for (let i = 0; i < 4096; i++)
        store.affinity({ ...context, agentId: String(i) }, "work");
      const next = store.create("claude-code", "next", "explicit", 72);
      const nextContext = store.context(next.id, "claude-code");
      alive = false;
      assert.doesNotThrow(() => store.affinity(nextContext, "work"));
      assert.equal(request.signal.aborted, true);
      release();
      release();
      for (let i = 1; i < 4096; i++)
        store.affinity({ ...nextContext, agentId: String(i) }, "work");
      assert.throws(
        () => store.affinity({ ...nextContext, agentId: "overflow" }, "work"),
        /affinity_store_full/,
      );
    } finally {
      release();
      store.close();
    }
  });

  for (const code of ["ESRCH", "EPERM", "EACCES", "EIO"]) {
    it(`treats ${code} as ${code === "ESRCH" ? "a dead owner" : "no proof of owner death"}`, (t) => {
      const time = clockFixture(), store = new ActionStore(time.clock);
      t.mock.method(process, "kill", () => {
        throw Object.assign(new Error("synthetic"), { code });
      });
      const action = store.create("claude-code", "synthetic", "explicit", 71);
      const context = store.context(action.id, "claude-code");
      const request = new AbortController(), release = store.admit(context, request);
      try {
        time.advance(60_000);
        if (code === "ESRCH") {
          assert.equal(request.signal.aborted, true);
          assert.throws(() => store.context(action.id, "claude-code"), /action_state_lost/);
        } else {
          assert.equal(request.signal.aborted, false);
          assert.deepEqual(store.context(action.id, "claude-code"), context);
        }
      } finally {
        release();
        store.close();
      }
    });
  }

  for (const ownerPid of [null, "71", 0, -1, 1.5, 2147483648]) {
    it(`rejects ownerPid=${JSON.stringify(ownerPid)} at the control boundary`, async () => {
      const rig = await fixture();
      try {
        const response = await rig.create(ownerPid);
        assert.equal(response.status, 400);
        const body: unknown = await response.json();
        assert.deepEqual(body, {
          type: "error",
          error: { type: "invalid_request_error", message: "invalid_action_context" },
        });
      } finally {
        await rig.close();
      }
    });
  }
});
