import { open, readFile, rename } from "node:fs/promises";
import { type Result, ok, err } from "./result.js";
import type { ProxyError } from "./errors.js";
import type { Logger } from "./logger.js";
import { AuthFileSchema, TokenResponseSchema, type AuthFile, type TokenResponse } from "./wire-types.js";

export const CODEX_OAUTH_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";

/** Refresh proactively when the access token expires within this margin. */
const REFRESH_MARGIN_MS = 120_000;

export interface CodexCredentials {
  readonly accessToken: string;
  readonly accountId: string;
}

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
    const tmpPath = `${path}.subroute-${process.pid}.tmp`;
    try {
      const handle = await open(tmpPath, "w", 0o600);
      try {
        await handle.writeFile(content, "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(tmpPath, path);
      return ok(undefined);
    } catch {
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

interface FileCredentials {
  readonly credentials: CodexCredentials;
  readonly expiresAtMs: number;
}

const credentialsFrom = (file: AuthFile): Result<FileCredentials, ProxyError> => {
  const accessToken = file.tokens.access_token;
  const accountId = file.tokens.account_id ?? jwtAccountId(accessToken);
  if (accountId === undefined) {
    return err({ kind: "auth", message: "codex account id not found in auth file or token — run `codex login`" });
  }
  return ok({
    credentials: { accessToken, accountId },
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

export class CodexAuthManager {
  private readonly store: AuthFileStore;
  private readonly oauthTokenUrl: string;
  private readonly logger: Logger;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private cached: FileCredentials | undefined;
  private refreshInflight: Promise<Result<CodexCredentials, ProxyError>> | undefined;

  constructor(options: CodexAuthOptions) {
    this.store = options.store;
    this.oauthTokenUrl = options.oauthTokenUrl;
    this.logger = options.logger;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.now = options.now ?? Date.now;
  }

  async getCredentials(): Promise<Result<CodexCredentials, ProxyError>> {
    if (this.cached !== undefined && this.cached.expiresAtMs - this.now() > REFRESH_MARGIN_MS) {
      return ok(this.cached.credentials);
    }
    const raw = await this.store.read();
    if (!raw.ok) return raw;
    const file = parseAuthFile(raw.value);
    if (!file.ok) return file;
    const fromFile = credentialsFrom(file.value);
    if (fromFile.ok && fromFile.value.expiresAtMs - this.now() > REFRESH_MARGIN_MS) {
      this.cached = fromFile.value;
      return ok(fromFile.value.credentials);
    }
    return this.refresh();
  }

  async forceRefresh(): Promise<Result<CodexCredentials, ProxyError>> {
    this.cached = undefined;
    return this.refresh();
  }

  /** Single-flight: concurrent callers share one refresh cycle. */
  private refresh(): Promise<Result<CodexCredentials, ProxyError>> {
    this.refreshInflight ??= this.doRefresh().finally(() => {
      this.refreshInflight = undefined;
    });
    return this.refreshInflight;
  }

  private async doRefresh(): Promise<Result<CodexCredentials, ProxyError>> {
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
  ): Promise<Result<CodexCredentials, ProxyError>> {
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
        const fromFile = credentialsFrom(fileNow);
        if (fromFile.ok) {
          this.cached = fromFile.value;
          return ok(fromFile.value.credentials);
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
      const fromMerged = credentialsFrom(merged);
      if (!fromMerged.ok) return fromMerged;
      this.cached = fromMerged.value;
      return ok(fromMerged.value.credentials);
    }

    // File vanished or corrupted mid-refresh: serve the fresh token from memory
    // so this request still succeeds; the next cycle re-reads from disk.
    this.logger.log("warn", "codex_auth_file_unreadable_after_refresh");
    const accountId = jwtAccountId(tokens.access_token);
    if (accountId === undefined) {
      return err({ kind: "auth", message: "refreshed codex token has no account id — run `codex login`" });
    }
    const fresh: FileCredentials = {
      credentials: { accessToken: tokens.access_token, accountId },
      expiresAtMs: jwtExpiryMs(tokens.access_token) ?? Number.POSITIVE_INFINITY,
    };
    this.cached = fresh;
    return ok(fresh.credentials);
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
