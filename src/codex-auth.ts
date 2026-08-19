import { open, readFile, rename, unlink } from "node:fs/promises";
import { type Result, ok, err } from "./result.js";
import type { ProxyError } from "./errors.js";
import type { Logger } from "./logger.js";
import type { ProviderAuth, ProviderCredential } from "./provider-auth.js";
import type { ProviderEvents } from "./provider-events.js";
import { AuthFileSchema, TokenResponseSchema, type AuthFile, type TokenResponse } from "./wire-types.js";

export const CODEX_OAUTH_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";

/** Refresh proactively when the access token expires within this margin. */
const REFRESH_MARGIN_MS = 120_000;

/**
 * Minimum interval between forced refreshes across requests. A persistent upstream
 * 401 that survives a freshly-minted token must not trigger a full OAuth round-trip
 * (token-endpoint call + fsync'd credential rewrite) on every subsequent request.
 * RELI-05: apply this floor in forceRefresh() using the lastForcedRefreshMs field.
 */
const FORCE_REFRESH_COOLDOWN_MS = 30_000;

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
    // Helper: open tmpPath with O_EXCL; on EEXIST (stale temp from a prior crashed run),
    // unlink the stale file and retry ONCE. If the retry also fails (e.g., because a
    // concurrent process raced to recreate the path), the error propagates to the outer
    // catch. This is a bounded, single-retry — not a loop.
    //
    // O_EXCL (the "x" in "wx") ensures the open fails if a file already exists at that
    // path. Without it, an attacker who pre-creates this path keeps their own mode on the
    // file and receives the token material before the rename places it over auth.json.
    // 0o600 grants only the process owner read/write access on the freshly-created file.
    // Cleanup idiom (unlink-in-catch) mirrors the makeRealFsDeps.writeFile in src/init.ts.
    const openExclusive = async () => {
      try {
        return await open(tmpPath, "wx", 0o600);
      } catch (e: unknown) {
        if ((e as { code?: string }).code !== "EEXIST") throw e;
        // Stale temp from a prior crash or another process that did not clean up.
        // Unlink it (the unlink may silently fail if another process races) then retry.
        await unlink(tmpPath).catch(() => undefined);
        return open(tmpPath, "wx", 0o600);
      }
    };
    try {
      const handle = await openExclusive();
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
  /**
   * Provider event names resolved at construction time from the closed `ProviderId`
   * union.  Threading these through options rather than hardcoding `"codex_*"` literals
   * ensures every auth event is table-derived — the same compile-time guarantee that
   * `codex-handler.ts` and `codex-response.ts` enjoy via `providerEvents("codex")`.
   */
  readonly events: ProviderEvents<"codex">;
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
  private readonly events: ProviderEvents<"codex">;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private cached: CachedTokenMaterial | undefined;
  private refreshInflight: Promise<Result<CodexTokenMaterial, ProxyError>> | undefined;
  /** Timestamp of the last successful forceRefresh() call, for RELI-05 cooldown. */
  private lastForcedRefreshMs: number | undefined;

  constructor(options: CodexAuthOptions) {
    this.store = options.store;
    this.oauthTokenUrl = options.oauthTokenUrl;
    this.logger = options.logger;
    this.events = options.events;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.now = options.now ?? Date.now;
  }

  async getCredentials(): Promise<Result<ProviderCredential<"codex">, ProxyError>> {
    return toCredentialResult(await this.loadMaterial());
  }

  async forceRefresh(): Promise<Result<ProviderCredential<"codex">, ProxyError>> {
    const now = this.now();
    // RELI-05: if we ran a full refresh very recently and still have a cached token,
    // serve the cached credential rather than hammering the token endpoint again.
    // A persistent upstream 401 that survives a freshly-minted token cannot be resolved
    // by re-running the same OAuth cycle; each cycle costs one token-endpoint call and
    // one fsync'd rewrite of auth.json. Without this floor, every concurrent request getting
    // 401 would launch its own token-endpoint call and fsync'd credential rewrite simultaneously.
    //
    // The cooldown only applies when we have a cached token — if the previous refresh
    // produced no usable credential, we always try again.
    if (
      this.lastForcedRefreshMs !== undefined &&
      now - this.lastForcedRefreshMs < FORCE_REFRESH_COOLDOWN_MS &&
      this.cached !== undefined
    ) {
      return ok(toCredential(this.cached.material));
    }
    this.lastForcedRefreshMs = now;
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
        this.logger.log("info", this.events.tokenRefreshed);
        return this.persistTokens(tokenResult.value, refreshToken, baselineLastRefresh);
      }
      if (tokenResult.error.invalidGrant && attempt === 0) {
        const reread = await this.store.read();
        if (reread.ok) {
          const rereadFile = parseAuthFile(reread.value);
          if (rereadFile.ok && rereadFile.value.tokens.refresh_token !== refreshToken) {
            this.logger.log("warn", this.events.refreshTokenRotatedExternally);
            refreshToken = rereadFile.value.tokens.refresh_token;
            baselineLastRefresh = rereadFile.value.last_refresh;
            continue;
          }
        }
      }
      this.logger.log("error", this.events.tokenRefreshFailed, { errorCode: tokenResult.error.invalidGrant ? "invalid_grant" : "token_endpoint_error" });
      return err({ kind: "auth", message: `codex token refresh failed (${tokenResult.error.message}) — run \`codex login\`` });
    }
    // INVARIANT VIOLATION — this line is unreachable when the loop bound (attempt < 2) and
    // the continue guard (attempt === 0) are in sync. The loop always exits via a return:
    //   - success → persistTokens (inside loop)
    //   - attempt 0 + invalidGrant + no rotation → error return (inside loop)
    //   - attempt 1 (any failure) → error return (inside loop, because attempt===0 is false)
    // Reaching here means these two have drifted apart in a later edit. This is a
    // programming error, not a credential condition — do not report it as one.
    // Match the idiom in codex-handler.ts (events.retryBoundViolated in the retry loop).
    this.logger.log("error", this.events.refreshRetryBoundViolated);
    return err({ kind: "upstream", message: "codex internal error: refresh retry bound violated", status: 500 });
  }

  private async callTokenEndpoint(refreshToken: string): Promise<Result<TokenResponse, TokenCallFailure>> {
    let response: Response;
    try {
      // RELI-04: bound the token-endpoint call to 15 s. Without a timeout, a hung OAuth
      // server holds the single-flight promise open indefinitely — all concurrent requests
      // share the one refreshInflight promise, blocking every pending request that needs
      // a token until the hung promise resolves or the 15 s AbortSignal.timeout fires.
      response = await this.fetchImpl(this.oauthTokenUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          client_id: CODEX_OAUTH_CLIENT_ID,
          grant_type: "refresh_token",
          refresh_token: refreshToken,
          scope: "openid profile email",
        }),
        signal: AbortSignal.timeout(15_000),
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
    refreshToken: string,
    baselineLastRefresh: string | undefined,
  ): Promise<Result<CodexTokenMaterial, ProxyError>> {
    const reread = await this.store.read();
    const rereadFile = reread.ok ? parseAuthFile(reread.value) : reread;

    if (rereadFile.ok) {
      const fileNow = rereadFile.value;
      // Primary signal: a different refresh_token means another writer rotated it —
      // this is format-independent and already the established idiom in doRefresh() at
      // the invalid_grant retry (line ~291). Secondary signal: numeric timestamp
      // comparison (Date.parse) ensures correct ordering when the Codex CLI writes
      // last_refresh in a format that differs from ours — e.g. "…08:00:05Z" vs
      // "…08:00:05.500Z" compares as '.' < 'Z' lexicographically (wrong) but as
      // equal-or-newer numerically (right). Note: Date.parse of an unrecognised format
      // returns NaN; NaN > NaN is false, so the secondary signal is inert for such
      // values — the primary identity check remains the reliable guard.
      const fileIsNewer =
        fileNow.tokens.refresh_token !== refreshToken ||
        (fileNow.last_refresh !== undefined &&
          (baselineLastRefresh === undefined ||
            Date.parse(fileNow.last_refresh) > Date.parse(baselineLastRefresh)));
      if (fileIsNewer) {
        // Another process refreshed while we were refreshing; its rotated
        // refresh token must not be clobbered. Newer file wins.
        this.logger.log("warn", this.events.authFileNewerThanRefresh);
        const fromFile = materialFrom(fileNow);
        if (fromFile.ok) {
          this.cached = fromFile.value;
          return ok(fromFile.value.material);
        }
        // materialFrom failed (e.g. malformed access_token in the newer file).
        // Do NOT fall through into the merge — that would clobber the other
        // writer's refresh_token with our now-consumed one. Serve our own valid
        // refresh result from memory instead so the request still succeeds.
        const accountId = jwtAccountId(tokens.access_token);
        if (accountId === undefined) return fromFile;
        const fresh: CachedTokenMaterial = {
          material: { accessToken: tokens.access_token, accountId },
          expiresAtMs: jwtExpiryMs(tokens.access_token) ?? Number.POSITIVE_INFINITY,
        };
        this.cached = fresh;
        return ok(fresh.material);
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
        // RELI-02: escalate to error when the response carried a new refresh_token, because
        // in that case the token endpoint rotated the token and the on-disk copy is now stale.
        // The next OAuth call will use the dead on-disk token (invalid_grant) rather than the
        // live in-memory one. A warn-level log here would make this silent in most dashboards.
        this.logger.log(tokens.refresh_token !== undefined ? "error" : "warn", this.events.authFileWriteFailed);
      }
      const fromMerged = materialFrom(merged);
      if (!fromMerged.ok) return fromMerged;
      this.cached = fromMerged.value;
      return ok(fromMerged.value.material);
    }

    // File vanished or corrupted mid-refresh: serve the fresh token from memory
    // so this request still succeeds; the next cycle re-reads from disk.
    this.logger.log("warn", this.events.authFileUnreadableAfterRefresh);
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
