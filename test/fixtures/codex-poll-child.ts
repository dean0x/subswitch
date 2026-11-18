import { CodexUsagePoller } from "../../src/codex-usage-poll.js";
import { CodexQuotaWriter } from "../../src/codex-quota-snapshot.js";
import { noopLogger } from "../../src/logger.js";
import { systemClock } from "../../src/routing/clock.js";
const url = process.argv[2]!;
if (new URL(url).hostname !== "127.0.0.1") process.exit(2);
const writer = new CodexQuotaWriter({ credentialFile: "/fixture/.codex/auth.json", logger: noopLogger, now: Date.now, write: async () => ({ ok: true }) });
new CodexUsagePoller({ url, writer, logger: noopLogger, clock: systemClock, userAgent: "fixture", fetchImpl: async (input, init) => {
  if (new URL(String(input)).hostname !== "127.0.0.1") throw new Error("non_loopback");
  const response = await fetch(input, init);
  process.stdout.write("requested\n");
  return response;
}, auth: { refreshable: false, async getCredentials() { return { ok: true, value: { provider: "codex", authHeaders: {} } }; }, async forceRefresh() { throw new Error("unexpected_refresh"); } } }).start();
