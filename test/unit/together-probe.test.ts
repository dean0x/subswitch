import assert from "node:assert/strict";
import { EventEmitter, once } from "node:events";
import { describe, it, type TestContext } from "node:test";
import { createCountingRelay, planRun, renderReport, runProbe, worstCaseUsd, type Price } from "../../e2e/gates/together.js";
import { chatChunk, chatSse } from "../helpers/chat-sse.js";
import { startFakeUpstream, type UpstreamHandler } from "../integration/fake-upstreams.js";

// Independent literals: the acknowledgement name, the row id and the bounds come from the plan.
const ACK = "SUBSWITCH_TOGETHER_PROBE_ACK_USD";
const KIMI = "moonshotai/Kimi-K3.1-Pro";
const KEY = "FAKE-TOGETHER-KEY-probe-0001";
const KEY_IN_REPORT = '{"success":false,"code":"key_in_report"}';

/** A Chat Completions body of exactly `bytes` bytes (ASCII, so length is bytes). A null max_tokens omits the field. */
const bodyOf = (bytes: number, maxTokens: number | null = 16, extra: object = {}): string => {
  const base = JSON.stringify({ model: "m", ...(maxTokens === null ? {} : { max_tokens: maxTokens }), messages: [], ...extra, pad: "" });
  return base.replace('"pad":""', `"pad":"${"x".repeat(bytes - base.length)}"`);
};

const okSse: UpstreamHandler = (_req, res) => {
  res.writeHead(200, { "content-type": "text/event-stream" });
  res.end(chatSse([chatChunk({ content: "ok" }, "stop"), "[DONE]"]));
};

const relayFixture = async (t: TestContext, handler: UpstreamHandler = okSse) => {
  const upstream = await startFakeUpstream(handler);
  t.after(upstream.close);
  const created = await createCountingRelay({ upstream: upstream.url });
  assert.ok(created.ok);
  const relay = created.value;
  t.after(relay.close);
  const send = async (body: string, init: { path?: string; method?: string; headers?: Record<string, string> } = {}) => {
    const method = init.method ?? "POST";
    const response = await fetch(`${relay.url}${init.path ?? "/v1/chat/completions"}`, {
      method, headers: { "content-type": "application/json", ...init.headers }, body: method === "GET" ? null : body,
    });
    await response.text();
    return response.status;
  };
  /** Send `count` small bodies and return their statuses. */
  const sendMany = async (count: number) => {
    const statuses: number[] = [];
    for (let i = 0; i < count; i++) statuses.push(await send(bodyOf(100)));
    return statuses;
  };
  return { upstream, relay, send, sendMany };
};

describe("worstCaseUsd", () => {
  it("gives 2.311104 USD for the fixed phases at the catalog prices", () => {
    assert.equal(worstCaseUsd(), 2.311104);
  });

  it("raises the worst case when a live price is above the catalog price", () => {
    // 4 × (196,608 × 3 + 4,096 × 10) + 8 × (16,384 × 3 + 2,048 × 10) + 6 × (12,288 × 3 + 16 × 10), per 1e6.
    assert.equal(worstCaseUsd(new Map<string, Price>([[KIMI, { in: 3, out: 10 }]])), 3.302336);
  });

  it("keeps the catalog price when a live price is below it", () => {
    assert.equal(worstCaseUsd(new Map<string, Price>([[KIMI, { in: 0.5, out: 1 }]])), 2.311104);
  });
});

describe("planRun", () => {
  it("refuses when CI is not empty", () => {
    assert.deepEqual(planRun({ CI: "true", [ACK]: "2.50" }), { ok: false, error: "ci_refused" });
  });

  it("accepts an empty CI value and a ceiling at or above the worst case", () => {
    assert.deepEqual(planRun({ CI: "", [ACK]: "2.32" }),
      { ok: true, value: { paidRequests: 18, ceilingUsd: 2.32, worstCaseUsd: 2.311104 } });
  });

  it("refuses with no acknowledgement", () => {
    assert.deepEqual(planRun({}), { ok: false, error: "ack_missing" });
  });

  it("refuses an acknowledgement that does not parse or is not above 0", () => {
    for (const ack of ["", "abc", "2.505", "-1", "1e3", " 2.50", "2.50\n", "2,50", "0", "0.00", "9".repeat(400)]) {
      const expected = ack === "" ? "ack_missing" : "ack_invalid";
      assert.deepEqual(planRun({ [ACK]: ack }), { ok: false, error: expected }, JSON.stringify(ack));
    }
  });

  it("refuses a ceiling below the worst case", () => {
    assert.deepEqual(planRun({ [ACK]: "2.31" }), { ok: false, error: "above_ceiling" });
  });

  it("refuses when live prices raise the worst case above the ceiling", () => {
    assert.deepEqual(planRun({ [ACK]: "2.50" }, new Map<string, Price>([[KIMI, { in: 3, out: 10 }]])),
      { ok: false, error: "above_ceiling" });
  });
});

describe("createCountingRelay", () => {
  it("binds to loopback and forwards only authorization, content-type, accept and user-agent", async (t) => {
    const { relay, send, upstream } = await relayFixture(t);
    relay.setPart(2);
    const status = await send(bodyOf(100), { headers: {
      authorization: `Bearer ${KEY}`, accept: "text/event-stream", "user-agent": "probe-test",
      "x-api-key": "fabricated-x-api-key", cookie: "a=b", "anthropic-beta": "fabricated-beta", "x-extra": "1",
    } });
    assert.equal(status, 200);
    assert.match(relay.url, /^http:\/\/127\.0\.0\.1:\d+$/);
    const [forwarded] = upstream.requests;
    assert.equal(forwarded?.url, "/v1/chat/completions");
    assert.equal(forwarded?.headers["authorization"], `Bearer ${KEY}`);
    assert.equal(forwarded?.headers["content-type"], "application/json");
    assert.equal(forwarded?.headers["accept"], "text/event-stream");
    assert.equal(forwarded?.headers["user-agent"], "probe-test");
    for (const name of ["x-api-key", "cookie", "anthropic-beta", "x-extra"]) assert.equal(forwarded?.headers[name], undefined, name);
  });

  it("refuses the fifth Part 1 request with a local 400 and no upstream request", async (t) => {
    const { relay, sendMany, upstream } = await relayFixture(t);
    relay.setPart(1);
    assert.deepEqual(await sendMany(5), [200, 200, 200, 200, 400]);
    assert.equal(upstream.requests.length, 4);
  });

  it("refuses request 19 after the 18 paid requests", async (t) => {
    const { relay, sendMany, upstream } = await relayFixture(t);
    relay.setPart(1);
    await sendMany(4);
    relay.setPart(2);
    await sendMany(8);
    relay.setPart(3);
    assert.deepEqual(await sendMany(7), [200, 200, 200, 200, 200, 200, 400]);
    assert.equal(upstream.requests.length, 18);
  });

  it("refuses a first Part 1 body above 128 KiB", async (t) => {
    const { relay, send, upstream } = await relayFixture(t);
    relay.setPart(1);
    assert.equal(await send(bodyOf(131_073)), 400);
    assert.equal(await send(bodyOf(131_072)), 200);
    assert.equal(upstream.requests.length, 1);
  });

  it("bounds later Part 1 bodies at the first body plus 64 KiB", async (t) => {
    const { relay, send, upstream } = await relayFixture(t);
    relay.setPart(1);
    assert.equal(await send(bodyOf(1_000)), 200);
    assert.equal(await send(bodyOf(1_000 + 65_537)), 400);
    assert.equal(await send(bodyOf(1_000 + 65_536)), 200);
    assert.equal(upstream.requests.length, 2);
  });

  it("refuses a Part 2 body above 16 KiB and a Part 3 body above 8 KiB", async (t) => {
    const { relay, send, upstream } = await relayFixture(t);
    relay.setPart(2);
    assert.deepEqual([await send(bodyOf(16_385)), await send(bodyOf(16_384))], [400, 200]);
    relay.setPart(3);
    assert.deepEqual([await send(bodyOf(8_193)), await send(bodyOf(8_192))], [400, 200]);
    assert.equal(upstream.requests.length, 2);
  });

  it("refuses a max_tokens above the phase bound, a missing one and a body that is not JSON", async (t) => {
    const { relay, send, upstream } = await relayFixture(t);
    relay.setPart(3);
    assert.deepEqual([await send(bodyOf(200, 17)), await send(bodyOf(200, null)), await send("not json"),
      await send(bodyOf(200, 16))], [400, 400, 400, 200]);
    assert.equal(upstream.requests.length, 1);
  });

  it("refuses another route, a second model list and a paid request before a part is set", async (t) => {
    const { send, upstream } = await relayFixture(t, (_req, res) => { res.writeHead(200); res.end("[]"); });
    assert.equal(await send(bodyOf(100)), 400);
    assert.equal(await send("", { path: "/v1/models", method: "GET" }), 200);
    assert.equal(await send("", { path: "/v1/models", method: "GET" }), 400);
    assert.equal(await send(bodyOf(100), { path: "/v1/messages" }), 400);
    assert.deepEqual(upstream.requests.map((request) => `${request.method} ${request.url}`), ["GET /v1/models"]);
  });

  it("records status, stop reasons, token counts, replay field names and the raw tool arguments", async (t) => {
    const { relay, send } = await relayFixture(t, (_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(chatSse([
        chatChunk({ tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "current_time", arguments: "" } }] }),
        chatChunk({}, "tool_calls"), { choices: [], usage: { prompt_tokens: 12, completion_tokens: 3 } }, "[DONE]",
      ]));
    });
    relay.setPart(2);
    await send(bodyOf(400, 16, { stream: true, messages: [{ role: "user", content: "q" },
      { role: "assistant", content: "", reasoning: "r" }, { role: "tool", tool_call_id: "call_0", content: "x" }] }));
    await relay.settled();
    const [record] = relay.records;
    assert.equal(record?.status, 200);
    assert.equal(record?.refused, null);
    assert.deepEqual(record?.finishReasons, ["tool_calls"]);
    assert.deepEqual(record?.toolArguments, [""]);
    assert.deepEqual([record?.promptTokens, record?.completionTokens], [12, 3]);
    assert.deepEqual(record?.replayFields, ["reasoning"]);
    assert.equal(record?.toolResults, 1);
    assert.equal(record?.stream, true);
  });

  it("closes the upstream when its client closes before the response ends", { timeout: 5000 }, async (t) => {
    const events = new EventEmitter();
    const { relay } = await relayFixture(t, (_req, res) => {
      res.once("close", () => events.emit("close"));
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(chatSse([chatChunk({ content: "partial" })]));
    });
    relay.setPart(2);
    const controller = new AbortController();
    const response = await fetch(`${relay.url}/v1/chat/completions`, {
      method: "POST", headers: { "content-type": "application/json" }, body: bodyOf(100), signal: controller.signal,
    });
    await response.body?.getReader().read();
    const upstreamClose = once(events, "close", { signal: AbortSignal.timeout(3000) });
    controller.abort();
    await upstreamClose;
    await relay.settled();
    assert.equal(relay.records[0]?.closedEarly, true);
  });
});

describe("renderReport", () => {
  it("prints only the refusal code for a report that holds the key", () => {
    assert.equal(renderReport({ steps: [{ detail: `upstream said ${KEY}` }] }, KEY), KEY_IN_REPORT);
  });

  it("finds a key with a quote or a backslash in its JSON-escaped form", () => {
    const key = 'FAKE-TOGETHER-KEY-a"b\\c';
    assert.equal(renderReport({ detail: key }, key), KEY_IN_REPORT);
  });

  it("prints the full report when the key is absent", () => {
    assert.equal(renderReport({ success: true, statuses: [200] }, KEY), '{"success":true,"statuses":[200]}');
  });
});

describe("runProbe control order", () => {
  /** A free model list that prices the Kimi row at `input` USD per 1M input tokens. */
  const modelList = (input: number): UpstreamHandler => (_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify([{ id: KIMI, pricing: { input, output: 10 } }]));
  };
  const probe = async (t: TestContext, env: Record<string, string>, options: { readonly upstream?: UpstreamHandler;
    readonly keychain?: () => Promise<{ stdout: string }>; readonly report?: { readonly success: boolean; readonly [field: string]: unknown } } = {}) => {
    const upstream = await startFakeUpstream(options.upstream ?? okSse);
    t.after(upstream.close);
    const exec = t.mock.fn(options.keychain ?? (async () => { throw new Error("no Keychain item"); }));
    // The fake live run keeps every test away from the Claude sign-in and Claude Code.
    const runLive = t.mock.fn(async () => options.report ?? { success: true });
    const lines: string[] = [];
    // A darwin reader with no env key must call the exec seam, so its count shows each key read.
    const code = await runProbe({ env, upstream: upstream.url, print: (line) => lines.push(line), runLive,
      keyReader: { env: {}, platform: "darwin", exec, setTimer: () => () => {} } });
    return { code, lines, keyReads: exec.mock.callCount(), liveRuns: runLive.mock.callCount(), upstream };
  };
  const keychainKey = async () => ({ stdout: KEY });

  it("refuses on CI before any key read or upstream request", async (t) => {
    const run = await probe(t, { CI: "1", [ACK]: "2.50" });
    assert.deepEqual(run.lines, ['{"success":false,"code":"ci_refused"}']);
    assert.deepEqual([run.code, run.keyReads, run.upstream.requests.length], [2, 0, 0]);
  });

  it("refuses above the ceiling before any key read", async (t) => {
    const run = await probe(t, { [ACK]: "2.31" });
    assert.deepEqual(run.lines, ['{"success":false,"code":"above_ceiling","worstCaseUsd":2.311104}']);
    assert.deepEqual([run.code, run.keyReads, run.upstream.requests.length], [2, 0, 0]);
  });

  it("prints the plan, then reads the key through the product loader, and stops with no upstream request when it is missing", async (t) => {
    const run = await probe(t, { [ACK]: "2.50" });
    assert.equal(run.lines.length, 2);
    const plan = JSON.parse(run.lines[0] ?? "{}").plan;
    assert.deepEqual([plan.paidRequests, plan.worstCaseUsd, plan.ceilingUsd], [18, 2.311104, 2.5]);
    assert.deepEqual(plan.bounds, { part1: { requests: 4, firstBodyBytes: 131_072, laterBodyBytes: "first + 65536", maxTokens: 4096 },
      part2: { requests: 8, bodyBytes: 16_384, maxTokens: 2048 }, part3: { requests: 6, bodyBytes: 8_192, maxTokens: 16 } });
    assert.equal(run.lines[1], '{"success":false,"code":"key_missing"}');
    assert.deepEqual([run.code, run.keyReads, run.upstream.requests.length], [2, 1, 0]);
  });

  it("refuses after the free model list when live prices raise the worst case, with no paid request", async (t) => {
    const run = await probe(t, { [ACK]: "2.50" }, { upstream: modelList(3), keychain: keychainKey });
    assert.equal(run.lines.at(-1), '{"success":false,"code":"above_ceiling","worstCaseUsd":3.302336}');
    assert.deepEqual(run.upstream.requests.map((request) => `${request.method} ${request.url}`), ["GET /v1/models"]);
    assert.equal(run.upstream.requests[0]?.headers["authorization"], `Bearer ${KEY}`);
    assert.ok(run.lines.every((line) => !line.includes(KEY)));
    assert.deepEqual([run.code, run.keyReads, run.liveRuns], [2, 1, 0]);
  });

  it("runs the live parts once when both checks pass and prints their report", async (t) => {
    const run = await probe(t, { [ACK]: "2.50" }, { upstream: modelList(2), keychain: keychainKey });
    assert.equal(run.lines.at(-1), '{"success":true}');
    assert.deepEqual([run.code, run.keyReads, run.liveRuns], [0, 1, 1]);
  });

  it("prints only the refusal code and exits 2 when the live report holds the key", async (t) => {
    const run = await probe(t, { [ACK]: "2.50" }, { upstream: modelList(2), keychain: keychainKey,
      report: { success: true, detail: KEY } });
    assert.equal(run.lines.at(-1), KEY_IN_REPORT);
    assert.equal(run.code, 2);
  });
});
