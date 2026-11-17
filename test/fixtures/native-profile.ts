/** Fabricated native stores for offline route tests. Never use a real sign-in file. */
import { mkdtempSync, writeFileSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { after } from "node:test";
import type { CredentialReference } from "../../src/routing/routing-types.js";

const directory = mkdtempSync(join(tmpdir(), "subswitch-synthetic-native-"));
after(() => rmSync(directory, { recursive: true, force: true }));

export function nativeCredential(
  provider: "claude" | "codex" | "kimi",
  account = "synthetic",
  region: "global" | "mainland-cn" = "global",
): CredentialReference {
  // Encode labels so every test store stays inside its temporary directory.
  const authFile = join(directory, `${provider}-${Buffer.from(account).toString("hex")}.json`);
  writeFileSync(authFile, JSON.stringify(provider === "codex" ? {
    tokens: { access_token: account, refresh_token: "synthetic-refresh", account_id: account },
  } : provider === "kimi" ? {
    version: 1, revision: "synthetic", generation: randomUUID(), deviceId: "fabricated-device", region,
    tokens: { access_token: account, refresh_token: "synthetic-refresh", token_type: "Bearer", expires_at: 4102444800 },
  } : {
    claudeAiOauth: { accessToken: account, refreshToken: "synthetic-refresh", expiresAt: 4102444800000 },
  }), { mode: 0o600 });
  return { kind: "native-oauth", authFile: provider === "kimi" ? realpathSync(authFile) : authFile };
}
