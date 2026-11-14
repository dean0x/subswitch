/** Offline production-path qualification. Owned files + loopback HTTP, fabricated tokens only. */
import assert from "node:assert/strict";
import { test } from "node:test";
import http from "node:http";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, readFile, writeFile, rm, rename, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KimiAuthManager } from "../../src/kimi-auth.js";
import { createKimiAuthStore, type KimiAuthRecord } from "../../src/kimi-auth-store.js";
import { ProfileAuth } from "../../src/routing/profile-auth.js";
import { RoutedAttempts } from "../../src/routing/routed-attempt.js";
import { destinationUrl } from "../../src/routing/destination-catalog.js";
import { inspectKimiProfiles } from "../../src/kimi-doctor.js";
import { loadConfig } from "../../src/config.js";
import { noopLogger } from "../../src/logger.js";
import type { AccessProfile, Item } from "../../src/routing/routing-types.js";
import { nativeEvents, messageFrames } from "../fixtures/native-messages.js";
import { aggregateFrames } from "../../src/codex-response.js";

for (const protocol of ["messages", "responses"] as const) test(`${protocol}: managed OAuth uses owned storage, beta route/identity, counted401retry and caller-owned tools`, async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "subswitch-managed-relay-")));
  const path = join(root, "auth.json"), noncePath = join(root, "nonce"), nonce = randomBytes(16).toString("hex");
  await writeFile(noncePath, nonce, { mode: 0o600 });
  const store = createKimiAuthStore(path), signal = AbortSignal.timeout(5000);
  const record: KimiAuthRecord = { version: 1, revision: "revision-1", generation: randomUUID(), deviceId: "device-1", region: "global", tokens: { access_token: "fabricated-first", refresh_token: "fabricated-refresh", expires_at: Math.floor(Date.now() / 1000) + 3600, token_type: "Bearer" } };
  await store.withLock(() => store.write(record, signal), signal);
  const profile: AccessProfile = { provider: "kimi", product: "kimi-code", billing: "subscription", region: "global", account: "personal", credential: { kind: "native-oauth", authFile: path } };
  const requests: { path: string; body: Item }[] = [], errors: unknown[] = [], dispatches: unknown[] = [];
  let refreshes = 0, fileReads = 0;
  const tool: Item = protocol === "messages" ? { type: "tool_use", id: "caller-tool:7", name: "caller_read", input: { path: noncePath } }
    : { type: "function_call", id: "caller-item:7", call_id: "caller-tool:7", name: "caller_read", arguments: JSON.stringify({ path: noncePath }), status: "completed" };
  const server = http.createServer((req, res) => { void (async () => {
    assert.match(req.headers["user-agent"]!, /^subswitch\//); assert.equal(req.headers["x-msh-platform"], "subswitch"); assert.equal(req.headers["x-msh-device-id"], "device-1");
    const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
    if (req.url === "/api/oauth/token") {
      assert.equal(req.headers.authorization, undefined); refreshes++;
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ access_token: "fabricated-new", refresh_token: "fabricated-new-refresh", expires_in: 3600 })); return;
    }
    const body = JSON.parse(Buffer.concat(chunks).toString()) as Item; requests.push({ path: req.url!, body });
    assert.equal(req.url, protocol === "messages" ? "/coding/v1/messages?beta=true" : "/coding/v1/responses");
    if (requests.length === 1) { res.writeHead(401).end("{}"); return; }
    assert.equal(req.headers.authorization, "Bearer fabricated-new");
    const item: Item = requests.length === 2 ? tool : protocol === "messages" ? { type: "text", text: nonce }
      : { type: "message", id: "caller-answer", role: "assistant", status: "completed", content: [{ type: "output_text", text: nonce, annotations: [] }] };
    const events = protocol === "messages" ? messageFrames(nativeEvents([item])) : [
      { type: "response.created", response: { id: "synthetic-response", status: "in_progress", output: [] } },
      { type: "response.output_item.done", output_index: 0, item },
      { type: "response.completed", response: { id: "synthetic-response", status: "completed", output: [item] } },
    ].map(e => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`);
    res.writeHead(200, { "content-type": "text/event-stream" }).end(events.join(""));
  })().catch(error => { errors.push(error); res.writeHead(500).end(); }); });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); assert.ok(address && typeof address !== "string"); const loopback = `http://127.0.0.1:${address.port}`;
  const auth = new ProfileAuth({ personal: profile }, noopLogger, {}, () => new KimiAuthManager({ store, region: "global", fixtureOrigin: loopback }));
  const attempts = new RoutedAttempts(auth, noopLogger, async (url, init) => {
    assert.equal(String(url), destinationUrl(profile, protocol));
    return fetch(loopback + new URL(String(url)).pathname + new URL(String(url)).search, init);
  }, undefined, undefined, dispatch => { if (dispatches.length >= 3) throw new Error("qualification_budget_exhausted"); assert.equal(dispatch.requestedOutputTokens, 256); dispatches.push(dispatch); });
  const body: Item = protocol === "messages" ? { model: "route", max_tokens: 256, system: "Caller system", messages: [{ role: "user", content: "Read caller file" }], tools: [{ name: "caller_read", input_schema: { type: "object", properties: { path: { type: "string" } } } }] }
    : { model: "route", max_output_tokens: 256, instructions: "Caller system", input: [{ role: "user", content: "Read caller file" }], tools: [{ type: "function", name: "caller_read", parameters: { type: "object", properties: { path: { type: "string" } } } }] };
  const refreshSet = new Set<string>();
  async function execute(input: Item, owner?: string) {
    const prepared = await attempts.prepare({ profile, target: { profile: "personal", model: "kimi-for-coding", effort: "high" }, body: input, protocol, conversation: "caller-conversation", signal, refreshes: refreshSet, ...(owner ? { expectedOwner: owner } : {}) });
    const events = []; try { for await (const event of prepared.events) events.push(event); prepared.commit(); } finally { await prepared.cancel(); }
    return { owner: prepared.owner, events };
  }
  try {
    const first = await execute(body); assert.equal(fileReads, 0); assert.ok(JSON.stringify(first.events).includes("caller-tool:7"));
    const content = await readFile(noncePath, "utf8"); fileReads++;
    const followup: Item = protocol === "messages" ? { ...body, messages: [...body.messages as Item[], { role: "assistant", content: [tool] }, { role: "user", content: [{ type: "tool_result", tool_use_id: "caller-tool:7", content }] }] }
      : { ...body, input: [...body.input as Item[], tool, { type: "function_call_output", call_id: "caller-tool:7", output: content }] };
    const final = await execute(followup, first.owner);
    const answer = protocol === "messages" ? aggregateFrames(final.events.map(e => `event: ${e.payload.type}\ndata: ${JSON.stringify(e.payload)}\n\n`), "codex") : final.events;
    assert.ok(JSON.stringify(answer).includes(nonce));
    assert.equal(fileReads, 1); assert.equal(refreshes, 1); assert.equal(dispatches.length, 3); assert.deepEqual(requests[0]?.body, requests[1]?.body);
    assert.equal(requests[2]?.body[protocol === "messages" ? "system" : "instructions"], "Caller system");
    assert.deepEqual(requests[2]?.body.tools, body.tools); assert.ok(JSON.stringify(requests[2]?.body).includes("caller-tool:7"));
    const rows: string[] = []; assert.equal(await inspectKimiProfiles({ personal: profile }, row => rows.push(row)), 0); assert.match(rows[0]!, /unverified/); assert.equal(refreshes, 1);
    const old = await auth.get("personal", signal);
    await assert.rejects(execute(followup, first.owner));
    assert.equal(requests.length, 3, "budget rejects a fourth dispatch before transport");
    const replacement = { ...record, generation: randomUUID(), revision: "new-revision" };
    const replacementPath = join(root, "replacement.json"); await writeFile(replacementPath, JSON.stringify(replacement), { mode: 0o600 }); await rename(replacementPath, path);
    await assert.rejects(execute(followup, first.owner), /credential_owner_changed/); assert.throws(() => auth.validate(old), /credential_binding_mismatch/);
    assert.equal(requests.length, 3); assert.deepEqual(errors, []);
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await rm(root, { recursive: true, force: true }); }
});

test("explicit config accepts isolated Kimi OAuth and existing key profiles, refuses native platform/redirects/relative stores", () => {
  const base = { provider: "kimi", product: "kimi-code", region: "global", billing: "subscription", account: "personal", credential: { kind: "native-oauth", authFile: "/fabricated/subswitch/auth.json" } };
  for (const profile of [base, { ...base, credential: { kind: "env", name: "FABRICATED_KEY" } }]) {
    assert.equal(loadConfig({ configPath: "/fabricated/config.json", env: {}, readFile: () => JSON.stringify({ configVersion: 2, accessProfiles: { personal: profile } }) }).ok, true);
  }
  for (const profile of [{ ...base, credential: { kind: "native-oauth", authFile: "relative.json" } }, { ...base, baseUrl: "https://attacker.invalid", allowInsecureBaseUrl: true }, { ...base, baseUrl: "http://127.0.0.1:8000" }, { ...base, product: "kimi-platform", billing: "api" }]) {
    assert.equal(loadConfig({ configPath: "/fabricated/config.json", env: {}, readFile: () => JSON.stringify({ configVersion: 2, accessProfiles: { personal: profile } }) }).ok, false);
  }
});
