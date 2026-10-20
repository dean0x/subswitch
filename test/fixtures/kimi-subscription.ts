import { abortable } from "../../src/abortable.js";
import type { KimiFixtureRecord, KimiFixtureScope, KimiFixtureStore, KimiSubscriptionFixtureOptions } from "../../src/kimi-subscription.js";

export const fixtureNow = 1_800_000_000_000;
export const fixtureScope: KimiFixtureScope = { product: "kimi-code", region: "global", account: "fabricated-account", generation: "fabricated-login" };
export function fixtureStore(expired = false) {
  let record: KimiFixtureRecord = { revision: "0", scope: { ...fixtureScope }, tokens: {
    access_token: "fabricated-access-token", refresh_token: "fabricated-refresh-token", token_type: "Bearer",
    expires_at: fixtureNow / 1000 + (expired ? -1 : 3600), unknown_native_field: "preserved",
  } };
  let queue = Promise.resolve();
  const stats = { reads: 0, writes: 0, activeLocks: 0, maxLocks: 0 };
  const store: KimiFixtureStore = {
    async read(signal) { signal.throwIfAborted(); stats.reads++; return structuredClone(record); },
    withLock<T>(operation: () => Promise<T>, signal: AbortSignal) {
      const pending = queue.then(async () => {
        signal.throwIfAborted(); stats.activeLocks++; stats.maxLocks = Math.max(stats.maxLocks, stats.activeLocks);
        try { return await operation(); } finally { stats.activeLocks--; }
      });
      queue = pending.then(() => {}, () => {});
      return abortable(pending, signal);
    },
    async compareAndSwap(revision, tokens, signal) {
      signal.throwIfAborted();
      if (record.revision !== revision) return false;
      record = { ...record, revision: String(Number(record.revision) + 1), tokens: structuredClone(tokens) }; stats.writes++; return true;
    },
  };
  return { store, stats, inspect: () => structuredClone(record),
    replace(scope = record.scope) { record = { ...record, revision: String(Number(record.revision) + 1), scope: { ...scope } }; } };
}
export function fixtureOptions(store: KimiFixtureStore, transport: typeof fetch, origin = "http://127.0.0.1:1"): KimiSubscriptionFixtureOptions {
  return { mode: "offline-fixture", scope: { ...fixtureScope }, store, transport, origin, clientId: "subswitch-offline-fixture", now: () => fixtureNow };
}
export const refreshResponse = () => Response.json({ access_token: "fabricated-new-access-token", refresh_token: "fabricated-new-refresh-token", expires_in: 3600 });
export const fixtureBody = (protocol: "messages" | "responses") => ({ model: "kimi-for-coding", stream: true,
  ...(protocol === "messages" ? { max_tokens: 256, messages: [{ role: "user", content: "fabricated prompt" }] } : { max_output_tokens: 256, input: [{ role: "user", content: "fabricated prompt" }] }) });
