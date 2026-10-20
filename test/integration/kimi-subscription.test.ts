/** Fabricated OAuth + model-only HTTP; no native login, agent or live endpoint. */
import assert from "node:assert/strict";
import { test } from "node:test";
import http from "node:http";
import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createKimiSubscription } from "../../src/kimi-subscription.js";
import { aggregateFrames } from "../../src/codex-response.js";
import { validatedProviderEvents } from "../../src/routing/provider-stream.js";
import { systemClock } from "../../src/routing/clock.js";
import type { AccessProfile, Item, WireProtocol } from "../../src/routing/routing-types.js";
import { nativeEvents, messageFrames } from "../fixtures/native-messages.js";
import { fixtureStore, fixtureOptions, fixtureBody } from "../fixtures/kimi-subscription.js";

function responseEvents(item: Item): Item[] {
  const tool = item.type === "function_call";
  return [
    { type: "response.created", response: { id: "caller-response", status: "in_progress", output: [] } },
    { type: "response.output_item.added", output_index: 0, item: { ...item, status: "in_progress", ...(tool ? { arguments: "" } : {}) } },
    ...(tool ? [{ type: "response.function_call_arguments.delta", output_index: 0, item_id: item.id, delta: item.arguments }] : []),
    { type: "response.output_item.done", output_index: 0, item },
    { type: "response.completed", response: { id: "caller-response", status: "completed", output: [item] } },
  ];
}
const profile: AccessProfile = { provider: "kimi", product: "kimi-code", region: "global", billing: "subscription", account: "fabricated-account",
  credential: { kind: "native-oauth", authFile: "/fabricated/not-discovered" } };
async function validated(response: Response, protocol: WireProtocol): Promise<Item> {
  const controller = new AbortController(); let final: Item | undefined; const frames: string[] = [];
  try { for await (const event of validatedProviderEvents(response, profile, protocol, controller.signal, controller, systemClock, value => { final = value; })) {
    frames.push(`event: ${event.event}\ndata: ${event.data}\n\n`);
  } }
  finally { controller.abort(); }
  if (protocol === "messages") {
    const aggregated = aggregateFrames(frames, "codex"); assert.ok(aggregated.ok);
    assert.equal(aggregated.value.kind, "message"); if (aggregated.value.kind === "message") return aggregated.value.message;
  }
  assert.ok(final); return final;
}

for (const protocol of ["messages", "responses"] as const) test(`${protocol}: caller tools/IDs/results and ordered stream survive native-auth fixture refresh`, async () => {
  const root = await mkdtemp(join(tmpdir(), "subswitch-kimi-subscription-"));
  const path = join(root, "nonce"); const nonce = randomBytes(18).toString("hex"); await writeFile(path, nonce, { mode: 0o600 });
  const received: Item[] = [], paths: string[] = [], failures: unknown[] = []; let reads = 0;
  const tool: Item = protocol === "messages" ? { type: "tool_use", id: "caller-tool:7", name: "caller_read", input: { path } }
    : { type: "function_call", id: "caller-item:7", call_id: "caller-tool:7", name: "caller_read", arguments: JSON.stringify({ path }), status: "completed" };
  const origin = http.createServer((req, res) => {
    void (async () => {
      paths.push(req.url!); const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
      assert.match(req.headers["user-agent"]!, /^subswitch\//); assert.equal(req.headers["x-msh-platform"], "subswitch");
      if (req.url === "/fixture/oauth/token") {
        assert.equal(req.headers.authorization, undefined); assert.equal(new URLSearchParams(Buffer.concat(chunks).toString()).get("client_id"), "subswitch-offline-fixture");
        res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ access_token: "fabricated-new-access-token", expires_in: 3600 })); return;
      }
      assert.equal(req.url, `/fixture/v1/${protocol}`); assert.equal(req.headers.authorization, "Bearer fabricated-new-access-token");
      const body = JSON.parse(Buffer.concat(chunks).toString()) as Item; received.push(body);
      const item: Item = received.length === 1 ? tool : protocol === "messages" ? { type: "text", text: nonce }
        : { type: "message", id: "caller-answer", role: "assistant", status: "completed", content: [{ type: "output_text", text: nonce, annotations: [] }] };
      const frames = protocol === "messages" ? messageFrames(nativeEvents([item])) : responseEvents(item).map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
      res.writeHead(200, { "content-type": "text/event-stream" }); res.write(frames[0]);
      setImmediate(() => res.end(frames.slice(1).join("")));
    })().catch(error => { failures.push(error); res.writeHead(500).end(); });
  });
  await new Promise<void>(resolve => origin.listen(0, "127.0.0.1", resolve));
  const address = origin.address(); assert.ok(address && typeof address !== "string");
  try {
    const f = fixtureStore(true); const fixture = createKimiSubscription(fixtureOptions(f.store, fetch, `http://127.0.0.1:${address.port}`));
    const body: Item = { ...fixtureBody(protocol), ...(protocol === "messages" ? { system: "Caller system instructions stay system.", tools: [{ name: "caller_read", input_schema: { type: "object" } }] }
      : { instructions: "Caller developer instructions stay instructions.", tools: [{ type: "function", name: "caller_read", parameters: { type: "object" } }] }) };
    const before = structuredClone(body), generation = (await fixture.credentials(AbortSignal.timeout(2000))).generation;
    const first = await validated(await fixture.request(protocol, body, AbortSignal.timeout(2000), generation), protocol);
    const block = (protocol === "messages" ? first.content : first.output) as Item[];
    assert.deepEqual(block, [tool]); assert.equal(reads, 0, "auth/model boundary must never execute caller tools");
    const result = await readFile(path, "utf8"); reads++;
    const followup: Item = protocol === "messages" ? { ...body, messages: [...body.messages as Item[], { role: "assistant", content: block }, { role: "user", content: [{ type: "tool_result", tool_use_id: "caller-tool:7", content: result }] }] }
      : { ...body, input: [...body.input as Item[], ...block, { type: "function_call_output", call_id: "caller-tool:7", output: result }] };
    const final = await validated(await fixture.request(protocol, followup, AbortSignal.timeout(2000), generation), protocol);
    assert.ok(JSON.stringify(final).includes(nonce)); assert.deepEqual(received, [before, followup]); assert.deepEqual(body, before);
    assert.equal(reads, 1); assert.deepEqual(paths, ["/fixture/oauth/token", `/fixture/v1/${protocol}`, `/fixture/v1/${protocol}`]);
    assert.deepEqual(fixture.budget(), { attempts: 2, tokens: 512, refreshes: 1 }); assert.deepEqual(failures, []);
    f.replace({ ...f.inspect().scope, generation: "different-login" });
    await assert.rejects(fixture.request(protocol, followup, AbortSignal.timeout(2000), generation), /owner_changed/);
    assert.equal(received.length, 2, "old action cannot move to a new login");
  } finally {
    origin.closeAllConnections(); await new Promise<void>(resolve => origin.close(() => resolve())); await rm(root, { recursive: true, force: true });
  }
});
