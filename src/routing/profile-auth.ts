import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import {
  CodexAuthManager,
  createFsAuthFileStore,
  readCodexAccountIdentity,
} from "../codex-auth.js";
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
import { object, ownValue } from "../plain-object.js";
import { abortable } from "../abortable.js";
import { supportsNativeOAuth } from "./destination-catalog.js";
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
  private readonly nativeStores = new Map<string, string>();
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
  private bindNativeStore(
    id: string,
    p: AccessProfile,
    storage: string | undefined,
  ): string {
    const key = JSON.stringify([p.provider, storage ?? id]);
    const previous = this.nativeStores.get(id);
    if (previous !== undefined && previous !== key) {
      this.managers.delete(id);
      this.generations.delete(id);
    }
    this.nativeStores.set(id, key);
    return key;
  }
  private invalidateNativeStore(key: string): void {
    for (const [id, storage] of this.nativeStores) {
      if (storage === key) {
        this.managers.delete(id);
        this.generations.delete(id);
      }
    }
  }
  private observeClaudeOwner(
    storage: string,
    token: string,
    refreshedFrom?: string,
  ): void {
    const previous = this.claudeOwners.get(storage);
    const owner =
      previous &&
      (previous.access === token || previous.access === refreshedFrom)
        ? previous.owner
        : digest(token);
    if (previous && previous.owner !== owner) {
      // Aliases of one native store share one allowance transition. Updating each
      // profile generation separately must not advance the allowance epoch again.
      const groups = new Set<string>();
      for (const [id, key] of this.nativeStores) {
        if (key === storage)
          groups.add(this.allowanceGroup(ownValue(this.profiles, id)!));
      }
      for (const group of groups)
        this.allowanceEpochs.set(
          group,
          (this.allowanceEpochs.get(group) ?? 0) + 1,
        );
    }
    this.claudeOwners.set(storage, { owner, access: token });
  }
  private manager(id: string, p: AccessProfile): NativeAuth {
    if (p.credential.kind !== "native-oauth" || !supportsNativeOAuth(p))
      throw new RoutingError("credential_product_mismatch");
    let manager = this.managers.get(id);
    if (manager) return manager;
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
      const ownerKey = this.bindNativeStore(id, p, store.coordinationKey);
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
          ...(store.coordinationKey
            ? { coordinationKey: store.coordinationKey }
            : {}),
          observeRefresh: (token, refreshedFrom) =>
            this.observeClaudeOwner(ownerKey, token, refreshedFrom),
          read: async () => {
            const raw = await store.read();
            this.observeClaudeOwner(ownerKey, access(raw));
            return raw;
          },
          // The manager publishes the verified predecessor token after persistence.
          write: (raw) => store.write(raw),
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
    const p = ownValue(this.profiles, id);
    if (!p) return false;
    return p.credential.kind === "native-oauth"
      ? supportsNativeOAuth(p) && existsSync(expandHome(p.credential.authFile))
      : !!ownValue(this.env, p.credential.name);
  }
  async get(
    id: string,
    signal: AbortSignal,
    refresh = false,
  ): Promise<BoundCredential> {
    const p = ownValue(this.profiles, id);
    if (!p) throw new RoutingError("unknown_profile");
    let headers: Readonly<Record<string, string>>, owner: string;
    if (p.credential.kind === "env") {
      const key = ownValue(this.env, p.credential.name);
      if (!key) throw new RoutingError("profile_credentials_missing", 503);
      if (!/^[!-~]{1,8192}$/.test(key))
        throw new RoutingError("invalid_profile_credential", 503);
      headers =
        p.provider === "claude"
          ? { "x-api-key": key }
          : { authorization: `Bearer ${key}` };
      owner = digest(key);
    } else {
      if (!supportsNativeOAuth(p))
        throw new RoutingError("credential_product_mismatch");
      if (p.provider === "codex") {
        const store = createFsAuthFileStore(expandHome(p.credential.authFile));
        const storage = this.bindNativeStore(id, p, store.coordinationKey);
        const read = await abortable(
          store.read(),
          AbortSignal.any([signal, AbortSignal.timeout(10000)]),
        );
        const account = read.ok ? readCodexAccountIdentity(read.value) : read;
        if (!account.ok) {
          // Losing a provable identity must invalidate previously bound credentials,
          // rather than leave the manager's cached account available for authentication.
          this.invalidateNativeStore(storage);
          this.fileAccounts.delete(storage);
          throw new RoutingError("profile_auth_unavailable", 503);
        }
        if (
          this.fileAccounts.has(storage) &&
          this.fileAccounts.get(storage) !== account.value
        )
          this.invalidateNativeStore(storage);
        this.fileAccounts.set(storage, account.value);
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
      if (p.provider === "claude") {
        const observed = this.claudeOwners.get(this.nativeStores.get(id) ?? id);
        if (
          !observed ||
          headers["authorization"] !== `Bearer ${observed.access}`
        )
          throw new RoutingError("credential_owner_changed", 409);
        owner = observed.owner;
      } else owner = headers["chatgpt-account-id"] ?? p.account;
    }
    const generation = digest([this.binding(id, p), owner]);
    const previous = this.generations.get(id);
    if (
      p.credential.kind === "env" &&
      previous !== undefined &&
      previous !== generation
    ) {
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
    const p = ownValue(this.profiles, credential.profile);
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
          digest(ownValue(this.env, p.credential.name)),
        ])
    )
      throw new RoutingError("credential_owner_changed", 409);
    if (p.credential.kind === "native-oauth") {
      const storage = this.nativeStores.get(credential.profile);
      const owner =
        storage === undefined
          ? undefined
          : p.provider === "codex"
            ? this.fileAccounts.get(storage)
            : this.claudeOwners.get(storage)?.owner;
      if (
        owner === undefined ||
        credential.generation !==
          digest([this.binding(credential.profile, p), owner])
      )
        throw new RoutingError("credential_binding_mismatch", 503);
    }
  }
  private allowanceGroup(p: AccessProfile): string {
    return JSON.stringify([p.provider, p.product, p.region, p.account]);
  }
  scope(credential: BoundCredential): AllowanceScope {
    this.validate(credential);
    const profile = ownValue(this.profiles, credential.profile)!;
    const nativeAccount = credential.authHeaders["chatgpt-account-id"];
    return {
      ...allowanceScope(profile),
      account: nativeAccount
        ? `native-${digest(nativeAccount)}`
        : `${profile.account}:${this.allowanceEpochs.get(this.allowanceGroup(profile)) ?? 0}`,
    };
  }
  refresh(id: string, signal: AbortSignal): Promise<BoundCredential> {
    const p = ownValue(this.profiles, id);
    if (p?.credential.kind !== "native-oauth")
      throw new RoutingError("profile_not_refreshable", 401);
    if (!supportsNativeOAuth(p))
      return Promise.reject(new RoutingError("credential_product_mismatch"));
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
