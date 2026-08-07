import { open, readFile, rename, unlink } from "node:fs/promises";
import { type Result, ok, err } from "./result.js";
import type { ProxyError } from "./errors.js";
import type { Logger } from "./logger.js";
import type { ProviderAuth, ProviderCredential } from "./provider-auth.js";
import { AuthFileSchema, TokenResponseSchema, type AuthFile, type TokenResponse } from "./wire-types.js";

export const CODEX_OAUTH_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";

/** Refresh proactively when the access token expires within this margin. */
const REFRESH_MARGIN_MS = 120_000;

/**
 * What this file parses out of `~/.codex/auth.json` — deliberately NOT exported.
 *
 * These two fields are the ChatGPT OAuth pair, not a shape any other provider owes.
 * The seam this class publishes is `ProviderCredential<"codex">`; this is the private
 * material that seam is derived from, and keeping it unexported is what stops the
 * ChatGPT-specific pair from becoming the de facto cross-provider credential type again.
 */
interface CodexTokenMaterial {
  readonly accessToken: string;
  readonly accountId: string;
}

/**
 * Project the private token material onto the branded credential the handler consumes.
 *
 * Called per request rather than cached: `this.cached` holds material, so the
 * interpolated `Bearer …` string is never given the cache's lifetime.
 */
const toCredential = (material: CodexTokenMaterial): ProviderCredential<"codex"> => ({
  provider: "codex",
  authHeaders: {
    authorization: `Bearer ${material.accessToken}`,
    "chatgpt-account-id": material.accountId,
  },
});

const toCredentialResult = (
  result: Result<CodexTokenMaterial, ProxyError>,
): Result<ProviderCredential<"codex">, ProxyError> => (result.ok ? ok(toCredential(result.value)) : result);

export interface AuthFileStore {
  read(): Promise<Result<string, ProxyError>>;
  writeAtomic(content: string): Promise<Result<void, ProxyError>>;
}

export const createFsAuthFileStore = (path: string): AuthFileStore => ({
  async read() {
    try {
      return ok(await readFile(path, "utf8"));
    } catch {
      return err({ kind: "auth", message: `cannot read codex auth file at ${path} — run \`codex login\`` });
    }
  },
  async writeAtomic(content) {
    const tmpPath = `${path}.subswitch-${process.pid}.tmp`;
    try {
      // O_EXCL (the "x" in "wx") ensures the open fails if the temp path already exists.
      // Without it, an attacker who pre-creates this path keeps their own mode on the file
      // and receives the token material written into it before the rename places it over
      // auth.json. Without the unlink in the catch block, a failure between open and rename
      // leaves a complete credential set on disk at a predictable path.
      // A stale or hostile temp now costs one failed refresh (self-healing on the next
      // attempt) rather than being silently written through. (mirrors src/init.ts:288-295)
      const handle = await open(tmpPath, "wx", 0o600);
      try {
        await handle.writeFile(content, "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(tmpPath, path);
      return ok(undefined);
    } catch {
      await unlink(tmpPath).catch(() => undefined);
      return err({ kind: "auth", message: `cannot write codex auth file at ${path}` });
    }
  },
});

const decodeJwtPayload = (token: string): Record<string, unknown> | undefined => {
  const payload = token.split(".")[1];
  if (payload === undefined) return undefined;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
};

const jwtExpiryMs = (token: string): number | undefined => {
  const exp = decodeJwtPayload(token)?.["exp"];
  return typeof exp === "number" ? exp * 1000 : undefined;
};

const jwtAccountId = (token: string): string | undefined => {
  const authClaim = decodeJwtPayload(token)?.["https://api.openai.com/auth"];
  if (typeof authClaim !== "object" || authClaim === null) return undefined;
  const accountId = (authClaim as Record<string, unknown>)["chatgpt_account_id"];
  return typeof accountId === "string" ? accountId : undefined;
};

const parseAuthFile = (raw: string): Result<AuthFile, ProxyError> => {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return err({ kind: "auth", message: "codex auth file is not valid JSON — run `codex login`" });
  }
  const parsed = AuthFileSchema.safeParse(json);
  if (!parsed.success) {
    return err({ kind: "auth", message: "codex auth file has an unexpected shape — run `codex login`" });
  }
  return ok(parsed.data);
};

interface CachedTokenMaterial {
  readonly material: CodexTokenMaterial;
  readonly expiresAtMs: number;
}

const materialFrom = (file: AuthFile): Result<CachedTokenMaterial, ProxyError> => {
  const accessToken = file.tokens.access_token;
  const accountId = file.tokens.account_id ?? jwtAccountId(accessToken);
  if (accountId === undefined) {
    return err({ kind: "auth", message: "codex account id not found in auth file or token — run `codex login`" });
  }
  return ok({
    material: { accessToken, accountId },
    expiresAtMs: jwtExpiryMs(accessToken) ?? Number.POSITIVE_INFINITY,
  });
};

interface TokenCallFailure {
  readonly invalidGrant: boolean;
  readonly message: string;
}

export interface CodexAuthOptions {
  readonly store: AuthFileStore;
  readonly oauthTokenUrl: string;
  readonly logger: Logger;
  readonly fetchImpl?: typeof fetch;
  readonly now?: () => number;
}

/**
 * `implements` is load-bearing, not decorative: it makes the compiler check conformance
 * here, at the definition, instead of only where the manager is injected. An edit that
 * broke the branded shape would otherwise surface as a puzzling error in `server.ts`.
 */
export class CodexAuthManager implements ProviderAuth<"codex"> {
  /**
   * Codex credentials are subscription OAuth tokens that rotate, so a pre-stream
   * 401 is worth exactly one forced refresh. Read by the handler to size its retry
   * bound; a static-key provider would set this false and get a single attempt.
   * (applies ADR-002)
   */
  readonly refreshable = true;

  private readonly store: AuthFileStore;
  private readonly oauthTokenUrl: string;
  private readonly logger: Logger;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private cached: CachedTokenMaterial | undefined;
  private refreshInflight: Promise<Result<CodexTokenMaterial, ProxyError>> | undefined;

  constructor(options: CodexAuthOptions) {
    this.store = options.store;
    this.oauthTokenUrl = options.oauthTokenUrl;
    this.logger = options.logger;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.now = options.now ?? Date.now;
  }

  async getCredentials(): Promise<Result<ProviderCredential<"codex">, ProxyError>> {
    return toCredentialResult(await this.loadMaterial());
  }

  async forceRefresh(): Promise<Result<ProviderCredential<"codex">, ProxyError>> {
    this.cached = undefined;
    return toCredentialResult(await this.refresh());
  }

  /**
   * Cached-or-loaded token material. Everything below this line works in material;
   * only the two public methods above cross the branded seam.
   */
  private async loadMaterial(): Promise<Result<CodexTokenMaterial, ProxyError>> {
    if (this.cached !== undefined && this.cached.expiresAtMs - this.now() > REFRESH_MARGIN_MS) {
      return ok(this.cached.material);
    }
    const raw = await this.store.read();
    if (!raw.ok) return raw;
    const file = parseAuthFile(raw.value);
    if (!file.ok) return file;
    const fromFile = materialFrom(file.value);
    if (fromFile.ok && fromFile.value.expiresAtMs - this.now() > REFRESH_MARGIN_MS) {
      this.cached = fromFile.value;
      return ok(fromFile.value.material);
    }
    return this.refresh();
  }

  /** Single-flight: concurrent callers share one refresh cycle. */
  private refresh(): Promise<Result<CodexTokenMaterial, ProxyError>> {
    this.refreshInflight ??= this.doRefresh().finally(() => {
      this.refreshInflight = undefined;
    });
    return this.refreshInflight;
  }

  private async doRefresh(): Promise<Result<CodexTokenMaterial, ProxyError>> {
    const initialRead = await this.store.read();
    if (!initialRead.ok) return initialRead;
    const initialFile = parseAuthFile(initialRead.value);
    if (!initialFile.ok) return initialFile;

    let refreshToken = initialFile.value.tokens.refresh_token;
    let baselineLastRefresh = initialFile.value.last_refresh;

    // Hard bound: at most 2 token-endpoint calls per refresh cycle. The second
    // attempt only happens after invalid_grant when another process (the Codex
    // CLI) rotated the refresh token under us — re-read and use the file's token.
    for (let attempt = 0; attempt < 2; attempt++) {
      const tokenResult = await this.callTokenEndpoint(refreshToken);
      if (tokenResult.ok) {
        this.logger.log("info", "codex_token_refreshed");
        return this.persistTokens(tokenResult.value, baselineLastRefresh);
      }
      if (tokenResult.error.invalidGrant && attempt === 0) {
        const reread = await this.store.read();
        if (reread.ok) {
          const rereadFile = parseAuthFile(reread.value);
          if (rereadFile.ok && rereadFile.value.tokens.refresh_token !== refreshToken) {
            this.logger.log("warn", "codex_refresh_token_rotated_externally");
            refreshToken = rereadFile.value.tokens.refresh_token;
            baselineLastRefresh = rereadFile.value.last_refresh;
            continue;
          }
        }
      }
      this.logger.log("error", "codex_token_refresh_failed", { errorCode: tokenResult.error.invalidGrant ? "invalid_grant" : "token_endpoint_error" });
      return err({ kind: "auth", message: `codex token refresh failed (${tokenResult.error.message}) — run \`codex login\`` });
    }
    return err({ kind: "auth", message: "codex token refresh exhausted retries — run `codex login`" });
  }

  private async callTokenEndpoint(refreshToken: string): Promise<Result<TokenResponse, TokenCallFailure>> {
    let response: Response;
    try {
      response = await this.fetchImpl(this.oauthTokenUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          client_id: CODEX_OAUTH_CLIENT_ID,
          grant_type: "refresh_token",
          refresh_token: refreshToken,
          scope: "openid profile email",
        }),
      });
    } catch {
      return err({ invalidGrant: false, message: "token endpoint unreachable" });
    }
    if (!response.ok) {
      let invalidGrant = false;
      try {
        const body: unknown = await response.json();
        invalidGrant =
          typeof body === "object" && body !== null && (body as Record<string, unknown>)["error"] === "invalid_grant";
      } catch {
        // Non-JSON error body: status alone decides.
      }
      return err({ invalidGrant, message: `token endpoint returned ${response.status}` });
    }
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      return err({ invalidGrant: false, message: "token endpoint returned invalid JSON" });
    }
    const parsed = TokenResponseSchema.safeParse(body);
    if (!parsed.success) {
      return err({ invalidGrant: false, message: "token endpoint response missing access_token" });
    }
    return ok(parsed.data);
  }

  private async persistTokens(
    tokens: TokenResponse,
    baselineLastRefresh: string | undefined,
  ): Promise<Result<CodexTokenMaterial, ProxyError>> {
    const reread = await this.store.read();
    const rereadFile = reread.ok ? parseAuthFile(reread.value) : reread;

    if (rereadFile.ok) {
      const fileNow = rereadFile.value;
      const fileIsNewer =
        fileNow.last_refresh !== undefined &&
        (baselineLastRefresh === undefined || fileNow.last_refresh > baselineLastRefresh);
      if (fileIsNewer) {
        // Another process refreshed while we were refreshing; its rotated
        // refresh token must not be clobbered. Newer file wins.
        this.logger.log("warn", "codex_auth_file_newer_than_refresh");
        const fromFile = materialFrom(fileNow);
        if (fromFile.ok) {
          this.cached = fromFile.value;
          return ok(fromFile.value.material);
        }
      }
      const merged: AuthFile = {
        ...fileNow,
        tokens: {
          ...fileNow.tokens,
          access_token: tokens.access_token,
          ...(tokens.id_token !== undefined ? { id_token: tokens.id_token } : {}),
          ...(tokens.refresh_token !== undefined ? { refresh_token: tokens.refresh_token } : {}),
        },
        last_refresh: new Date(this.now()).toISOString(),
      };
      const written = await this.store.writeAtomic(`${JSON.stringify(merged, null, 2)}\n`);
      if (!written.ok) {
        this.logger.log("warn", "codex_auth_file_write_failed");
      }
      const fromMerged = materialFrom(merged);
      if (!fromMerged.ok) return fromMerged;
      this.cached = fromMerged.value;
      return ok(fromMerged.value.material);
    }

    // File vanished or corrupted mid-refresh: serve the fresh token from memory
    // so this request still succeeds; the next cycle re-reads from disk.
    this.logger.log("warn", "codex_auth_file_unreadable_after_refresh");
    const accountId = jwtAccountId(tokens.access_token);
    if (accountId === undefined) {
      return err({ kind: "auth", message: "refreshed codex token has no account id — run `codex login`" });
    }
    const fresh: CachedTokenMaterial = {
      material: { accessToken: tokens.access_token, accountId },
      expiresAtMs: jwtExpiryMs(tokens.access_token) ?? Number.POSITIVE_INFINITY,
    };
    this.cached = fresh;
    return ok(fresh.material);
  }
}

// ---------------------------------------------------------------------------
// Doctor support: summarize auth state without ever exposing token material.
// ---------------------------------------------------------------------------

export interface AuthInspection {
  readonly authMode: string;
  readonly accountIdSuffix: string;
  readonly accessTokenExpiresAt: string | undefined;
  readonly lastRefresh: string | undefined;
}

export const inspectAuthFile = (raw: string): Result<AuthInspection, ProxyError> => {
  const file = parseAuthFile(raw);
  if (!file.ok) return file;
  const accountId = file.value.tokens.account_id ?? jwtAccountId(file.value.tokens.access_token) ?? "";
  const expiresAtMs = jwtExpiryMs(file.value.tokens.access_token);
  return ok({
    authMode: file.value.auth_mode ?? "unknown",
    accountIdSuffix: accountId === "" ? "(none)" : `…${accountId.slice(-6)}`,
    accessTokenExpiresAt: expiresAtMs === undefined ? undefined : new Date(expiresAtMs).toISOString(),
    lastRefresh: file.value.last_refresh,
  });
};
