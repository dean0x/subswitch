/** Synthetic providers and isolated diagnostic storage; never exhaust real quota. */
import assert from "node:assert/strict";
import http from "node:http";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { gzipSync } from "node:zlib";
import { describe, it } from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket, WebSocketServer } from "ws";
import { createRawHttpForwarder } from "../../src/raw-http-passthrough.js";
import { createOpenaiPassthrough } from "../../src/openai-passthrough.js";
import { loadConfig } from "../../src/config.js";
import { SharedRouting } from "../../src/routing/shared-routing.js";
import {
  LimitRecorder,
  readLimitObservations,
  withLimitRecorder,
} from "../../src/limit-recorder.js";
import { nativeProcess } from "../../e2e/gates/native-process.js";
import type {
  LimitObservation,
  LimitContext,
} from "../../src/limit-observation.js";
import type { Logger } from "../../src/logger.js";
const error = JSON.stringify({
  error: { type: "rate_limit_error", message: "private prompt content" },
});
async function listen(server: http.Server): Promise<string> {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error();
  return "http://127.0.0.1:" + address.port;
}
const close = async (server: http.Server) => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
};
function get(url: string): Promise<{ status: number; body: Buffer }> {
  return new Promise((resolve, reject) => {
    http
      .get(url, (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("end", () =>
          resolve({
            status: response.statusCode!,
            body: Buffer.concat(chunks),
          }),
        );
        response.on("error", reject);
      })
      .on("error", reject);
  });
}
async function until(predicate: () => boolean) {
  const deadline = Date.now() + 10000;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, "diagnostic fixture timed out");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
describe("production native limit observation", () => {
  for (const context of [
    { provider: "claude", product: "anthropic-unknown", protocol: "messages" },
    { provider: "codex", product: "chatgpt-codex", protocol: "responses" },
    { provider: "codex", product: "openai-api", protocol: "responses" },
  ] satisfies LimitContext[]) {
    it("preserves native error bytes for " + context.product, async () => {
      const records: LimitObservation[] = [],
        logger: Logger = {
          log() {},
          recordLimit: (record) => {
            records.push(record);
          },
        };
      const backend = http.createServer((_req, res) => {
        res.writeHead(429, {
          "content-type": "application/json",
          "retry-after": "120",
          authorization: "private-token",
        });
        res.end(error);
      });
      const upstream = await listen(backend);
      const forward = createRawHttpForwarder({
        baseUrl: upstream,
        logger,
        limitContext: context,
        connectTimeoutMs: 1000,
        maxUpstreamSockets: 2,
        logPath: () => "/",
        errorBody: () => "{}",
        events: { error: "test_error", timeout: "test_timeout" },
      });
      const proxy = http.createServer((req, res) => forward(req, res));
      const base = await listen(proxy);
      try {
        const result = await get(base + "/v1/messages");
        assert.equal(result.status, 429);
        assert.equal(result.body.toString(), error);
        assert.equal(records.length, 1);
        assert.equal(records[0]!.context.product, context.product);
        assert.equal(records[0]!.headers["retry-after"], "120");
        assert.ok(!JSON.stringify(records).includes("private"));
      } finally {
        forward.close();
        await close(proxy);
        await close(backend);
      }
    });
  }
  it("decodes bounded compressed errors for artifacts while preserving compressed native bytes", async () => {
    const dir = await mkdtemp(join(tmpdir(), "subswitch-limit-compressed-"));
    const recorder = new LimitRecorder(join(dir, "records"), { log() {} }),
      logger = withLimitRecorder({ log() {} }, recorder);
    const bytes = gzipSync(error);
    const backend = http.createServer((_req, res) => {
      res.writeHead(429, { "content-encoding": "gzip" });
      res.end(bytes);
    });
    const upstream = await listen(backend);
    const forward = createRawHttpForwarder({
      baseUrl: upstream,
      logger,
      limitContext: {
        provider: "claude",
        product: "claude-code",
        protocol: "messages",
      },
      connectTimeoutMs: 1000,
      maxUpstreamSockets: 2,
      logPath: () => "/",
      errorBody: () => "{}",
      events: { error: "test_error", timeout: "test_timeout" },
    });
    const proxy = http.createServer((req, res) => forward(req, res));
    const base = await listen(proxy);
    try {
      const result = await get(base + "/v1/messages");
      assert.deepEqual(result.body, bytes);
      await recorder.flush();
      const records = await readLimitObservations(recorder.directory);
      assert.equal(records.length, 1);
      assert.equal(records[0]!.bodyState, "json");
      assert.match(JSON.stringify(records), /rate_limit_error/);
      assert.ok(!JSON.stringify(records).includes("private"));
    } finally {
      forward.close();
      await close(proxy);
      await close(backend);
      await rm(dir, { recursive: true, force: true });
    }
  });
  it("delivers initial native SSE bytes before upstream completion and observes its late error", async () => {
    const records: LimitObservation[] = [],
      logger: Logger = {
        log() {},
        recordLimit: (record) => {
          records.push(record);
        },
      };
    let upstreamResponse: http.ServerResponse | undefined;
    const start = 'event: message_start\ndata: {"type":"message_start"}\n\n';
    const backend = http.createServer((_req, res) => {
      upstreamResponse = res;
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "retry-after": "60",
      });
      res.write(start);
    });
    const upstream = await listen(backend);
    const forward = createRawHttpForwarder({
      baseUrl: upstream,
      logger,
      limitContext: {
        provider: "claude",
        product: "anthropic-unknown",
        protocol: "messages",
      },
      connectTimeoutMs: 1000,
      maxUpstreamSockets: 2,
      logPath: () => "/",
      errorBody: () => "{}",
      events: { error: "test_error", timeout: "test_timeout" },
    });
    const proxy = http.createServer((req, res) => forward(req, res));
    const base = await listen(proxy);
    try {
      const response = await fetch(base + "/v1/messages");
      const reader = response.body!.getReader();
      assert.equal(Buffer.from((await reader.read()).value!).toString(), start);
      assert.equal(records.length, 0);
      upstreamResponse!.end(
        'event: error\ndata: {"type":"error","error":{"type":"rate_limit_error"}}\n\n',
      );
      while (!(await reader.read()).done) {
        /* Drain the original response. */
      }
      assert.equal(records.length, 1);
      assert.equal(records[0]!.transport, "sse");
      assert.equal(records[0]!.providerStartSeen, true);
      assert.equal(records[0]!.headers["retry-after"], "60");
    } finally {
      forward.close();
      await close(proxy);
      await close(backend);
    }
  });
  it("captures default raw native WebSocket failures while retaining the original handshake and message", async () => {
    const records: LimitObservation[] = [],
      logger: Logger = {
        log() {},
        recordLimit: (record) => {
          records.push(record);
        },
      };
    const backend = http.createServer(),
      wss = new WebSocketServer({ server: backend, perMessageDeflate: false });
    const message =
      '{"type":"error","status":429,"error":{"code":"usage_limit_reached","message":"private"}}';
    wss.on("connection", (socket) => socket.send(message));
    const upstream = await listen(backend);
    const loaded = loadConfig({
      env: {},
      configPath: "/synthetic/config",
      readFile: () =>
        JSON.stringify({
          codexIngress: {
            enabled: true,
            subscriptionBaseUrl: upstream,
            apiBaseUrl: upstream,
          },
        }),
    });
    if (!loaded.ok) throw new Error(loaded.error.message);
    const forward = createOpenaiPassthrough(
      loaded.value.config.codexIngress,
      logger,
    );
    const proxy = http.createServer();
    proxy.on("upgrade", (req, socket, head) =>
      forward.upgrade(req, socket, head, "subscription", "/responses"),
    );
    const base = await listen(proxy);
    let client: WebSocket | undefined;
    try {
      client = new WebSocket(base.replace("http:", "ws:") + "/responses", {
        perMessageDeflate: false,
      });
      const received = await once(client, "message");
      assert.equal(received[0].toString(), message);
      await until(() => records.length === 1);
      assert.equal(records.length, 1);
      assert.equal(records[0]!.context.product, "chatgpt-codex");
      assert.ok(!JSON.stringify(records).includes("private"));
    } finally {
      client?.terminate();
      forward.close();
      for (const socket of wss.clients) socket.terminate();
      wss.close();
      await close(proxy);
      await close(backend);
    }
  });
});
describe("explicit route observations and inspection", () => {
  it("automatically records a naturally arriving failure in the serve entrypoint", async () => {
    const dir = await mkdtemp(join(tmpdir(), "subswitch-limit-serve-"));
    const backend = http.createServer((_req, res) => {
      res.writeHead(429, { "retry-after": "60" });
      res.end(error);
    });
    const upstream = await listen(backend);
    const reserve = http.createServer();
    const reserved = await listen(reserve);
    const port = new URL(reserved).port;
    await close(reserve);
    let child: ReturnType<typeof spawn> | undefined;
    try {
      await writeFile(
        join(dir, "subswitch.config.json"),
        JSON.stringify({
          port: Number(port),
          anthropic: { baseUrl: upstream },
        }),
      );
      child = spawn(
        process.execPath,
        [
          "--import",
          import.meta.resolve("tsx"),
          join(process.cwd(), "src/cli.ts"),
          "serve",
        ],
        {
          cwd: dir,
          env: {
            ...process.env,
            SUBSWITCH_CONFIG: join(dir, "subswitch.config.json"),
            SUBSWITCH_LIMIT_RECORDING: "1",
            SUBSWITCH_LIMIT_DIR: join(dir, "limits"),
          },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      let stderr = "";
      child.stderr!.on("data", (chunk) => {
        stderr += String(chunk);
      });
      child.stdout!.on("data", () => undefined);
      await until(() => stderr.includes("subswitch ready"));
      const result = await get("http://127.0.0.1:" + port + "/v1/messages");
      assert.equal(result.status, 429);
      assert.equal(result.body.toString(), error);
      const exited = once(child, "exit");
      child.kill("SIGTERM");
      const [code] = await exited;
      assert.equal(code, 0);
      const records = await readLimitObservations(join(dir, "limits", port));
      assert.equal(records.length, 1);
      assert.equal(records[0]!.status, 429);
      assert.ok(!JSON.stringify(records).includes("private"));
    } finally {
      if (child && child.exitCode === null) {
        const stopped = once(child, "exit");
        child.kill("SIGKILL");
        await stopped;
      }
      await close(backend);
      await rm(dir, { recursive: true, force: true });
    }
  });
  function config() {
    const loaded = loadConfig({
      env: {},
      configPath: "/synthetic/config",
      readFile: () =>
        JSON.stringify({
          configVersion: 2,
          accessProfiles: {
            code: {
              provider: "kimi",
              product: "kimi-code",
              region: "global",
              billing: "subscription",
              account: "synthetic",
              credential: { kind: "env", name: "CODE_KEY" },
            },
            api: {
              provider: "codex",
              product: "openai-api",
              billing: "api",
              account: "synthetic",
              credential: { kind: "env", name: "API_KEY" },
            },
          },
          routes: {
            work: {
              clients: ["codex"],
              primary: { profile: "code", model: "k3", effort: "high" },
              fallbacks: [
                { profile: "api", model: "gpt-6-sol", effort: "high" },
              ],
              affinity: "native-or-explicit",
            },
          },
        }),
    });
    if (!loaded.ok) throw new Error(loaded.error.message);
    return loaded.value.config;
  }
  it("records the original quota envelope before translation and preserves ordered fallback", async () => {
    const records: LimitObservation[] = [];
    let calls = 0;
    const router = new SharedRouting(
      config(),
      {
        log() {},
        recordLimit: (record) => {
          records.push(record);
        },
      },
      undefined,
      async () => {
        if (++calls === 1)
          return new Response(
            JSON.stringify({
              error: {
                message:
                  "You've reached your weekly (7-day) usage limit. private",
              },
            }),
            { status: 403, headers: { "retry-after": "120" } },
          );
        return new Response(
          'data: {"type":"response.created","response":{"id":"synthetic","status":"in_progress","output":[]}}\n\n' +
            'data: {"type":"response.completed","response":{"id":"synthetic","status":"completed","output":[]}}\n\n',
          { headers: { "content-type": "text/event-stream" } },
        );
      },
      { CODE_KEY: "synthetic", API_KEY: "synthetic" },
    );
    try {
      const action = router.actions.create("codex", "thread");
      for await (const event of router.events(
        { model: "work", input: "synthetic", stream: true },
        "codex",
        "work",
        new AbortController().signal,
        router.actions.context(action.id, "codex"),
      ))
        void event;
      assert.equal(calls, 2);
      assert.equal(records.length, 1);
      assert.equal(records[0]!.context.product, "kimi-code");
      assert.equal(records[0]!.context.attempt, 0);
      assert.match(records[0]!.context.scopeHash!, /^[a-f0-9]{64}$/);
      assert.equal(records[0]!.context.region, "global");
      assert.equal(records[0]!.committed, false);
      assert.ok(!JSON.stringify(records).includes("private"));
    } finally {
      router.close();
    }
  });
  it("keeps unrecognized failures unrecognized after recording instead of enabling paid fallback", async () => {
    const records: LimitObservation[] = [];
    let calls = 0;
    const router = new SharedRouting(
      config(),
      {
        log() {},
        recordLimit: (record) => {
          records.push(record);
        },
      },
      undefined,
      async () => {
        calls++;
        return new Response(
          JSON.stringify({
            error: { code: "undocumented_failure", message: "private" },
          }),
          { status: 403 },
        );
      },
      { CODE_KEY: "synthetic", API_KEY: "synthetic" },
    );
    try {
      const action = router.actions.create("codex", "thread");
      await assert.rejects(async () => {
        for await (const event of router.events(
          { model: "work", input: "synthetic" },
          "codex",
          "work",
          new AbortController().signal,
          router.actions.context(action.id, "codex"),
        ))
          void event;
      });
      assert.equal(calls, 1);
      assert.equal(records.length, 1);
      assert.equal(records[0]!.candidate, "possible-limit");
      assert.ok(!JSON.stringify(records).includes("undocumented_failure"));
    } finally {
      router.close();
    }
  });
  it("honors provider retry constraints on pre-commit SSE quota errors", async () => {
    let now = 1000;
    const configured = config();
    configured.routes!.work!.fallbacks = [];
    const router = new SharedRouting(
      configured,
      { log() {} },
      { now: () => now, monotonic: () => now, random: () => 0.5 },
      async () =>
        new Response(
          'event: error\ndata: {"type":"error","error":{"status":403,"message":"You\\u0027ve reached your weekly (7-day) usage limit."}}\n\n',
          {
            headers: {
              "content-type": "text/event-stream",
              "retry-after": "3600",
            },
          },
        ),
      { CODE_KEY: "synthetic" },
    );
    try {
      await assert.rejects(async () => {
        for await (const event of router.events(
          { model: "work" },
          "codex",
          "work",
          new AbortController().signal,
        ))
          void event;
      });
      const credential = await router.attempts.auth.get(
          "code",
          new AbortController().signal,
        ),
        scope = router.attempts.auth.scope(credential);
      now += 61000;
      assert.equal(router.quota.readiness(scope), "exhausted");
      now = 3601000;
      assert.equal(router.quota.readiness(scope), "eligible-for-retry");
    } finally {
      router.close();
    }
  });
  it("reads records through the CLI without authentication or valid routing configuration", async () => {
    const dir = await mkdtemp(join(tmpdir(), "subswitch-limit-cli-"));
    try {
      const records: LimitObservation[] = [];
      const recorder = new LimitRecorder(join(dir, "12345"), { log() {} });
      const router = new SharedRouting(
        config(),
        {
          log() {},
          recordLimit: (record) => {
            records.push(record);
            recorder.record(record);
          },
        },
        undefined,
        async () => new Response(error, { status: 429 }),
        { CODE_KEY: "synthetic", API_KEY: "synthetic" },
      );
      try {
        const action = router.actions.create("codex", "thread");
        await assert.rejects(async () => {
          for await (const event of router.events(
            { model: "work" },
            "codex",
            "work",
            new AbortController().signal,
            router.actions.context(action.id, "codex"),
          ))
            void event;
        });
      } finally {
        router.close();
      }
      await recorder.flush();
      const result = await nativeProcess(
        process.execPath,
        [
          "--import",
          "tsx",
          "src/cli.ts",
          "limits",
          "--json",
          "--port",
          "12345",
        ],
        {
          cwd: process.cwd(),
          env: { ...process.env, SUBSWITCH_LIMIT_DIR: dir },
          timeoutMs: 10000,
        },
      );
      assert.equal(result.code, 0);
      const report = JSON.parse(result.stdout);
      assert.equal(report.schemaVersion, 1);
      assert.equal(report.records.length, records.length);
      assert.ok(!result.stdout.includes("private"));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
