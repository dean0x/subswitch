import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { CodexAuthManager, createFsAuthFileStore } from "../codex-auth.js";
import {
  ClaudeAuthManager,
  createClaudeCredentialStore,
} from "../claude-auth.js";
import { expandHome } from "../config.js";
import type { Logger } from "../logger.js";
import type { ProviderCredential } from "../provider-auth.js";
import type { Result } from "../result.js";
import type { ProxyError } from "../errors.js";
import { providerEvents } from "../provider-events.js";
import { object } from "../plain-object.js";
import {
  allowanceScope,
  RoutingError,
  type AllowanceScope,
  type AccessProfile,
  type DestinationProviderId,
} from "./routing-types.js";

export interface BoundCredential
  extends ProviderCredential<DestinationProviderId> {
  profile: string;
  generation: string;
  binding: string;
}
export function abortable<T>(
  promise: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const cleanup = () => signal.removeEventListener("abort", abort);
    const abort = () => {
      cleanup();
      reject(signal.reason);
    };
    signal.addEventListener("abort", abort, { once: true });
    promise.then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (error) => {
        cleanup();
        reject(error);
      },
    );
  });
}
type NativeAuth = {
  getCredentials(): Promise<
    Result<ProviderCredential<DestinationProviderId>, ProxyError>
  >;
  forceRefresh(): Promise<
    Result<ProviderCredential<DestinationProviderId>, ProxyError>
  >;
};
const digest = (value: unknown) =>
  createHash("sha256")
    .update(JSON.stringify(value) ?? "null")
    .digest("hex");
const boundedRefreshFetch: typeof fetch = (url, init) =>
  fetch(url, {
    ...init,
    redirect: "error",
    signal: AbortSignal.any([
      ...(init?.signal ? [init.signal] : []),
      AbortSignal.timeout(10000),
    ]),
  });

/** Managers are profile-local; ordinary OAuth refresh does not change the account generation. */
export class ProfileAuth {
  private readonly managers = new Map<string, NativeAuth>();
  private readonly generations = new Map<string, string>();
  private readonly refreshes = new Map<string, Promise<BoundCredential>>();
  private readonly fileAccounts = new Map<string, string>();
  private readonly claudeOwners = new Map<
    string,
    { owner: string; access: string }
  >();
  private readonly allowanceEpochs = new Map<string, number>();
  constructor(
    private readonly profiles: Readonly<Record<string, AccessProfile>>,
    private readonly logger: Logger,
    private readonly env: NodeJS.ProcessEnv = process.env,
  ) {}
  private binding(id: string, p: AccessProfile): string {
    return digest([id, p]);
  }
  private manager(id: string, p: AccessProfile): NativeAuth {
    let manager = this.managers.get(id);
    if (manager) return manager;
    if (p.credential.kind !== "native-oauth")
      throw new RoutingError("credential_product_mismatch");
    if (p.provider === "codex")
      manager = new CodexAuthManager({
        store: createFsAuthFileStore(expandHome(p.credential.authFile)),
        oauthTokenUrl: "https://auth.openai.com/oauth/token",
        logger: this.logger,
        events: providerEvents("codex"),
        fetchImpl: boundedRefreshFetch,
      });
    else {
      const store = createClaudeCredentialStore({
        authFile: p.credential.authFile,
      });
      const access = (raw: string): string => {
        const token = object(object(JSON.parse(raw))?.["claudeAiOauth"])?.[
          "accessToken"
        ];
        if (typeof token !== "string")
          throw new RoutingError("profile_auth_unavailable", 503);
        return token;
      };
      manager = new ClaudeAuthManager({
        store: {
          read: async () => {
            const raw = await store.read(),
              token = access(raw),
              old = this.claudeOwners.get(id);
            if (!old || old.access !== token)
              this.claudeOwners.set(id, {
                owner: digest(token),
                access: token,
              });
            return raw;
          },
          write: async (raw) => {
            await store.write(raw);
            const token = access(raw),
              old = this.claudeOwners.get(id);
            // A refresh performed by this manager proves the same credential lineage.
            // An external replacement has no such proof and conservatively invalidates replay.
            this.claudeOwners.set(id, {
              owner: old?.owner ?? digest(token),
              access: token,
            });
          },
        },
        oauthTokenUrl: "https://platform.claude.com/v1/oauth/token",
        logger: this.logger,
        fetchImpl: boundedRefreshFetch,
      });
    }
    this.managers.set(id, manager);
    return manager;
  }
  has(id: string): boolean {
    const p = this.profiles[id];
    if (!p) return false;
    return p.credential.kind === "native-oauth"
      ? existsSync(expandHome(p.credential.authFile))
      : !!this.env[p.credential.name];
  }
  async get(
    id: string,
    signal: AbortSignal,
    refresh = false,
  ): Promise<BoundCredential> {
    const p = this.profiles[id];
    if (!p) throw new RoutingError("unknown_profile");
    let headers: Readonly<Record<string, string>>, owner: string;
    if (p.credential.kind === "env") {
      const key = this.env[p.credential.name];
      if (!key) throw new RoutingError("profile_credentials_missing", 503);
      if (!/^[!-~]{1,8192}$/.test(key))
        throw new RoutingError("invalid_profile_credential", 503);
      headers =
        p.provider === "claude"
          ? { "x-api-key": key }
          : { authorization: `Bearer ${key}` };
      owner = digest(key);
    } else {
      if (p.provider === "codex") {
        const read = await abortable(
          createFsAuthFileStore(expandHome(p.credential.authFile)).read(),
          AbortSignal.any([signal, AbortSignal.timeout(10000)]),
        );
        if (!read.ok) throw new RoutingError("profile_auth_unavailable", 503);
        let account: unknown;
        try {
          account = object(object(JSON.parse(read.value))?.["tokens"])?.[
            "account_id"
          ];
        } catch {
          throw new RoutingError("profile_auth_unavailable", 503);
        }
        if (typeof account === "string") {
          if (
            this.fileAccounts.has(id) &&
            this.fileAccounts.get(id) !== account
          )
            this.managers.delete(id);
          this.fileAccounts.set(id, account);
        }
      }
      const manager = this.manager(id, p);
      const result = await abortable(
        refresh ? manager.forceRefresh() : manager.getCredentials(),
        AbortSignal.any([signal, AbortSignal.timeout(10000)]),
      );
      signal.throwIfAborted();
      if (!result.ok) throw new RoutingError("profile_auth_unavailable", 503);
      if (result.value.provider !== p.provider)
        throw new RoutingError("credential_binding_mismatch", 503);
      headers = result.value.authHeaders;
      // Native account identifiers, when supplied, survive refresh. Profile scope remains
      // conservative for Claude, whose native auth contract exposes no account header.
      owner =
        headers["chatgpt-account-id"] ??
        this.claudeOwners.get(id)?.owner ??
        p.account;
    }
    const generation = digest([this.binding(id, p), owner]);
    const previous = this.generations.get(id);
    if (previous !== undefined && previous !== generation) {
      const group = this.allowanceGroup(p);
      this.allowanceEpochs.set(
        group,
        (this.allowanceEpochs.get(group) ?? 0) + 1,
      );
    }
    this.generations.set(id, generation);
    return {
      provider: p.provider,
      profile: id,
      generation,
      binding: this.binding(id, p),
      authHeaders: headers,
    };
  }
  validate(credential: BoundCredential): void {
    if (
      Object.values(credential.authHeaders).some(
        (value) => !/^[\x20-\x7e]{1,16384}$/.test(value),
      )
    )
      throw new RoutingError("invalid_profile_credential", 503);
    const p = this.profiles[credential.profile];
    if (
      !p ||
      p.provider !== credential.provider ||
      credential.binding !== this.binding(credential.profile, p) ||
      this.generations.get(credential.profile) !== credential.generation
    )
      throw new RoutingError("credential_binding_mismatch", 503);
    if (
      p.credential.kind === "env" &&
      credential.generation !==
        digest([
          this.binding(credential.profile, p),
          digest(this.env[p.credential.name]),
        ])
    )
      throw new RoutingError("credential_owner_changed", 409);
  }
  private allowanceGroup(p: AccessProfile): string {
    return JSON.stringify([p.provider, p.product, p.region, p.account]);
  }
  scope(credential: BoundCredential): AllowanceScope {
    this.validate(credential);
    const profile = this.profiles[credential.profile]!;
    const nativeAccount = credential.authHeaders["chatgpt-account-id"];
    return {
      ...allowanceScope(profile),
      account: nativeAccount
        ? `native-${digest(nativeAccount)}`
        : `${profile.account}:${this.allowanceEpochs.get(this.allowanceGroup(profile)) ?? 0}`,
    };
  }
  refresh(id: string, signal: AbortSignal): Promise<BoundCredential> {
    const p = this.profiles[id];
    if (p?.credential.kind !== "native-oauth")
      throw new RoutingError("profile_not_refreshable", 401);
    let pending = this.refreshes.get(id);
    if (!pending) {
      pending = this.get(id, AbortSignal.timeout(10000), true).finally(() =>
        this.refreshes.delete(id),
      );
      this.refreshes.set(id, pending);
    }
    return abortable(pending, signal);
  }
}
