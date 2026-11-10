/** Shared fake action/auth/in-memory transport. Never opens a socket or credential file. */
import assert from "node:assert/strict";
import { loadConfig } from "../../src/config.js";
import { noopLogger } from "../../src/logger.js";
import { ClaudeCache } from "../../src/claude-cache.js";
import type { OrderedReplayDiagnostics } from "../../src/routing/replay-cache.js";
import { SharedRouting } from "../../src/routing/shared-routing.js";
import { RoutedAttempts, type AttemptRequest, type RoutedPrepared } from "../../src/routing/routed-attempt.js";
import { ProfileAuth, type BoundCredential } from "../../src/routing/profile-auth.js";
import { systemClock } from "../../src/routing/clock.js";
import { allowanceScope, RoutingError, type AccessProfile, type Item } from "../../src/routing/routing-types.js";
import { added, created, done, terminal, textItem } from "./kimi-responses-bridge.js";

export const profile: AccessProfile = { provider: "kimi", product: "kimi-code", region: "global", billing: "subscription",
  account: "synthetic", credential: { kind: "native-oauth", authFile: "/fabricated/never-read" } };
export const target = { profile: "fixture", model: "kimi-for-coding", effort: "high" };
export const ordered = (): Item => ({ model: "work", stream: true, max_tokens: 128, system: "initial",
  messages: [{ role: "user", content: "first" }, { role: "system", content: [{ type: "text", text: "later1" }, { type: "text", text: "later2" }] },
    { role: "user", content: "next" }], tools: [{ name: "inspect", description: "Caller tool", input_schema: { type: "object" } }] });
export const ordinary = (): Item => ({ model: "work", stream: true, messages: [{ role: "system", content: "leading" }, { role: "user", content: "first" }] });
export function output() {
  const message = textItem("msg", ["שלום 🦊", "separate"]);
  const call = { type: "function_call", id: "provider-item", call_id: "caller-id", name: "inspect", arguments: '{"n":7}', status: "completed" };
  return [created(), added(0, { ...message, content: [], status: "in_progress" }), done(0, message),
    added(1, { ...call, arguments: "", status: "in_progress" }), done(1, call), terminal([message, call])];
}
export const nativeMessages = (): Item[] => [
  { type: "message_start", message: { id: "msg-native", type: "message", model: target.model, role: "assistant", content: [], usage: { input_tokens: 1, output_tokens: 0 } } },
  { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } }, { type: "message_stop" },
];
export function wire(events: Item[]) { return events.map(e => `event: ${e["type"]}\ndata: ${JSON.stringify({ sequence_number: events.indexOf(e), ...e })}\n\n`).join(""); }
export function response(raw = wire(output()), fragment = 65536, atEof = () => {}) {
  const bytes = Buffer.from(raw); let offset = 0;
  return new Response(new ReadableStream<Uint8Array>({ pull(c) {
    if (offset >= bytes.length) { atEof(); c.close(); return; }
    const next = Math.min(bytes.length, offset + fragment); c.enqueue(bytes.subarray(offset, next)); offset = next;
  } }), { headers: { "content-type": "text/event-stream" } });
}
class FakeAuth extends ProfileAuth {
  generation = "generation1"; gets = 0; refreshCount = 0; rotateOnRefresh = false;
  constructor() { super({ fixture: profile }, noopLogger, {}); }
  override has() { return true; }
  override async get(name = "fixture"): Promise<BoundCredential> { this.gets++; return { profile: name, provider: "kimi", generation: this.generation,
    binding: "fabricated", authHeaders: { authorization: "Bearer fabricated-only" } }; }
  override validate(c: BoundCredential) { if (c.generation !== this.generation) throw new RoutingError("credential_owner_changed", 409); }
  override identity() { return { "user-agent": "subswitch/synthetic" }; }
  override scope() { return allowanceScope(profile); }
  override async refresh() { this.refreshCount++; if (this.rotateOnRefresh) this.generation = "generation2"; return this.get(); }
}
export function fixture(options: { reply?: (index: number, request: Item, url: string) => Response; action?: boolean; fallback?: boolean;
  beforePrepare?: (r: AttemptRequest) => void; prepared?: (r: RoutedPrepared) => void; cache?: ClaudeCache; profile?: AccessProfile;
  model?: string;
  clock?: import("../../src/routing/clock.js").RoutingClock;
  diagnostics?: OrderedReplayDiagnostics;
  effort?: "low" | "high" | "max" } = {}) {
  const clock = options.clock ?? systemClock;
  const p = options.profile ?? profile, auth = new FakeAuth(), cache = options.cache ?? new ClaudeCache();
  const selected = { ...target, model: options.model ?? target.model, effort: options.effort ?? target.effort };
  const sent: { url: string; body: Item; serialized: string }[] = [], timeline: string[] = [];
  const logs: Parameters<typeof noopLogger.log>[] = [];
  const logger = { log(...args: Parameters<typeof noopLogger.log>) { logs.push(args); } };
  let physicalAdmissions = 0, cacheWriteCalls = 0;
  const put = cache.put.bind(cache), putBatch = cache.putBatch.bind(cache);
  cache.put = (kind, id, value, pending) => { cacheWriteCalls++; put(kind, id, value, pending); };
  cache.putBatch = (writes, pending) => { cacheWriteCalls++; putBatch(writes, pending); };
  let eof = false, commits = 0, successes = 0, reserves = 0, releases = 0;
  const loaded = loadConfig({ configPath: "/fabricated/config", env: {}, readFile: () => JSON.stringify({ configVersion: 2,
    accessProfiles: { fixture: p, backup: { ...p, account: "backup" } }, routes: { work: { clients: ["claude-code", "codex"], primary: selected,
      fallbacks: options.fallback ? [{ ...selected, profile: "backup" }] : [], affinity: "native-or-explicit", transientTriggers: [] } }, codexIngress: { enabled: true } }) });
  if (!loaded.ok) throw Error(loaded.error.message);
  const fetchImpl: typeof fetch = async (url, init) => {
    const serialized = String(init?.body), body = JSON.parse(serialized) as Item, index = sent.length + 1;
    sent.push({ url: String(url), body, serialized });
    assert.equal(init?.redirect, "error"); assert.equal((init?.headers as Item)["user-agent"], "subswitch/synthetic");
    timeline.push("fetch");
    return options.reply?.(index, body, String(url)) ?? response(undefined, 1, () => { eof = true; timeline.push("eof"); });
  };
  const router = new SharedRouting(loaded.value.config, logger, clock, fetchImpl, {});
  const attempts = new RoutedAttempts(auth, logger, fetchImpl, clock, "subswitch", () => { physicalAdmissions++; }, undefined, router.actions,
    undefined, options.diagnostics);
  Object.defineProperty(attempts, "replay", { value: cache });
  const prepare = attempts.prepare.bind(attempts);
  attempts.prepare = async r => { options.beforePrepare?.(r); const ready = await prepare(r); options.prepared?.(ready);
    const commit = ready.commit; ready.commit = () => { commit(); commits++; timeline.push("cache-commit"); }; return ready; };
  Object.defineProperty(router, "attempts", { value: attempts });
  const reserve = router.quota.reserve.bind(router.quota), success = router.quota.success.bind(router.quota), release = router.quota.release.bind(router.quota);
  router.quota.reserve = (...args) => { reserves++; return reserve(...args); };
  router.quota.success = (...args) => { success(...args); successes++; timeline.push("quota-success"); };
  router.quota.release = (...args) => { releases++; return release(...args); };
  const controller = new AbortController();
  const context = options.action !== false || options.fallback ? router.actions.context(router.actions.create("claude-code", "synthetic-thread").id, "claude-code") : undefined;
  return { router, auth, attempts, cache, sent, timeline, logs, controller, context,
    stats: () => ({ eof, commits, successes, reserves, releases }),
    effects: () => ({ physicalAdmissions, cacheWriteCalls }),
    async run(body = ordered(), client: "claude-code" | "codex" = "claude-code", onEvent?: (e: Item) => void) {
      const seen: Item[] = []; let error: unknown;
      try { for await (const e of router.events(body, client, "work", controller.signal, context?.client === client ? context : undefined)) { timeline.push("frame"); seen.push(e); onEvent?.(e); } }
      catch (caught) { error = caught; }
      return { seen, error };
    },
  };
}
