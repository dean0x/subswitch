import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { type Result, ok, err } from "./result.js";
import type { ProxyError } from "./errors.js";
import type { LogLevel } from "./logger.js";
import { isReservedAnthropicName, PROVIDER_IDS, type ProviderId, type AliasesByProvider } from "./models.js";

export const DEFAULT_PORT = 4141 as const;

/**
 * Default Codex auth file path (tilde-unexpanded).
 * Exported so callers derive the path via expandHome() rather than
 * hardcoding join(homedir(), ".codex", "auth.json") independently.
 */
export const DEFAULT_CODEX_AUTH_FILE = "~/.codex/auth.json";

// ---------------------------------------------------------------------------
// Loopback helper — shared between schema refinements and buildDeps runtime checks
// ---------------------------------------------------------------------------

/**
 * True when a URL's hostname is a loopback address.
 *
 * Loopback addresses are exempt from the HTTPS requirement because the e2e dev
 * workflow intentionally points `baseUrl` at `http://127.0.0.1:4142`
 * (see `e2e/capture/codex-recorder.ts` and `e2e/README.md`).
 *
 * Exported so `buildDeps` can apply the same logic without duplication.
 */
export const isLoopbackHost = (hostname: string): boolean =>
  hostname === "localhost" ||
  hostname === "::1" ||
  hostname === "127.0.0.1" ||
  hostname.startsWith("127.");

/**
 * Zod refinement: a URL must use https, or http to a loopback address.
 *
 * Relies on `z.url()` having already validated the URL, so `new URL(url)` is safe.
 */
const requireHttpsOrLoopback = (url: string): boolean => {
  const { protocol, hostname } = new URL(url);
  return protocol === "https:" || isLoopbackHost(hostname);
};

const HTTPS_REQUIRED_MESSAGE =
  "must use https:// (or http:// to 127.*/localhost/::1 for local dev); " +
  "an http:// URL to a non-loopback host sends credentials in cleartext";

// ---------------------------------------------------------------------------
// Sub-schemas (FileConfig layer)
// ---------------------------------------------------------------------------

const AnthropicSchema = z
  .strictObject({
    baseUrl: z
      .url()
      .refine(requireHttpsOrLoopback, { message: `anthropic.baseUrl ${HTTPS_REQUIRED_MESSAGE}` })
      .default("https://api.anthropic.com"),
    /**
     * TCP connection-establishment timeout for the Anthropic leg (milliseconds).
     * Bounds only the time to establish a new TCP connection; the timer is armed
     * directly on the socket (not via `ClientRequest.setTimeout`, which defers
     * internally and cannot bound the connect phase).
     * Once TCP connects the timer is re-armed to `headerTimeoutMs`.
     *
     * On HTTPS connections, `'connect'` fires after TCP establishment but before
     * the TLS handshake, so TLS negotiation falls under `headerTimeoutMs`.
     *
     * Has no effect on reused pooled sockets (no connect phase).
     */
    connectTimeoutMs: z.number().int().positive().default(10_000),
    /**
     * @deprecated The relay must never bound the headers phase on a connected client
     * (ADR-010). Kept in the schema so existing config files with this key do not
     * hard-error on load; the value is silently ignored. Remove from your config.
     */
    headerTimeoutMs: z.number().int().positive().optional(),
    /**
     * @deprecated The relay must never bound the stream-idle phase on a connected client
     * (ADR-010). Kept in the schema so existing config files with this key do not
     * hard-error on load; the value is silently ignored. Remove from your config.
     * Use providers.codex.streamIdleTimeoutMs for the Codex leg instead.
     */
    streamIdleTimeoutMs: z.number().int().positive().optional(),
    /**
     * Maximum sockets in the keep-alive pool for the Anthropic passthrough.
     *
     * Raised from 32 to 256: with byte-based admission the concurrency gate no longer
     * caps request count at 32, so realistic peak (~100 concurrent) would queue inside
     * the http.Agent at 32 sockets, adding ~2 extra full-request-latency waves of
     * invisible, error-free latency. 256 gives comfortable headroom over peak concurrency.
     */
    maxUpstreamSockets: z.number().int().positive().default(256),
    /**
     * Opt-in to a non-default `anthropic.baseUrl` host.
     *
     * When false (the default), `subswitch serve` refuses to start if
     * `anthropic.baseUrl` points at a host other than `api.anthropic.com`, because
     * doing so would forward the user's Anthropic credentials to an untrusted host.
     * Loopback addresses (127.0.0.0/8, localhost, ::1) are always exempt — the wire-recorder
     * workflow uses `http://127.0.0.1`.
     *
     * Set to `true` only when you intentionally route through a trusted proxy that
     * sits in front of Anthropic's API.
     */
    allowInsecureBaseUrl: z.boolean().default(false),
  })
  .prefault({});

// Both sides are bounded to the same 200 chars as ModelPeekSchema's `model`: an
// alias target flows into the outbound request body and the `route` log field, so
// an unbounded one would be a config-side hole in a limit the request side enforces.
const AliasesSchema = z
  .record(z.string().min(1).max(200), z.string().min(1).max(200))
  .refine((aliases) => !Object.keys(aliases).some(isReservedAnthropicName), {
    message:
      "alias keys matching 'claude-*' or Anthropic tier words (sonnet, opus, haiku, inherit) are rejected — they would silently misroute Anthropic traffic to Codex",
  })
  .refine((aliases) => !Object.values(aliases).some(isReservedAnthropicName), {
    message:
      "alias targets matching 'claude-*' or Anthropic tier words (sonnet, opus, haiku, inherit) are rejected — the target becomes routable and would silently misroute Anthropic traffic to Codex",
  })
  .default({});

const CodexProviderSchema = z
  .strictObject({
    /**
     * Discriminant for provider-type dispatch in resolveConfig.
     *
     * Zod reads discriminator fields before defaults fire, so `kind` cannot carry
     * `.default('codex')` — it must be injected by the caller before parsing.
     * `ProvidersSchema` injects it from the record key via `z.preprocess`.
     *
     * It does not survive into the resolved `Config`: there it is redundant with
     * the `providers` record key that already selects the slice.
     */
    kind: z.literal("codex"),
    baseUrl: z
      .url()
      .refine(requireHttpsOrLoopback, { message: `providers.codex.baseUrl ${HTTPS_REQUIRED_MESSAGE}` })
      .default("https://chatgpt.com/backend-api/codex"),
    oauthTokenUrl: z
      .url()
      .refine(requireHttpsOrLoopback, { message: `providers.codex.oauthTokenUrl ${HTTPS_REQUIRED_MESSAGE}` })
      .default("https://auth.openai.com/oauth/token"),
    authFile: z.string().min(1).default(DEFAULT_CODEX_AUTH_FILE),
    // default UA format verified from codex-cli 0.144.6 live capture 2026-07-22;
    // machine-telemetry (OS/arch/terminal) intentionally omitted — set providers.codex.userAgent
    // to override (vendor-drift pressure valve).
    userAgent: z.string().min(1).default("codex_cli_rs/0.144.6"),
    // codex.aliases maps user-defined alias names to canonical model ids.
    // Both sides are checked against isReservedAnthropicName (PF-007).
    aliases: AliasesSchema,
    reasoningCache: z
      .object({
        maxEntries: z.number().int().positive().default(4096),
        maxBytes: z.number().int().positive().default(64 * 1024 * 1024),
      })
      .prefault({}),
    /** Per-Codex-request total time limit. */
    requestTimeoutMs: z.number().int().positive().default(600_000),
    /** Codex stream idle timeout — resets on each SSE data chunk. */
    streamIdleTimeoutMs: z.number().int().positive().default(300_000),
    /** Maximum bytes per individual SSE event from the Codex upstream. */
    maxSseEventBytes: z.number().int().positive().default(4 * 1024 * 1024),
    /**
     * Maximum total accumulated frame bytes for non-streaming response aggregation.
     *
     * Every other buffer on the non-streaming path is bounded: the SSE parser caps
     * individual events at `maxSseEventBytes`, the request body is capped at
     * `maxBodyBytes`, and the translator now has `MAX_CONTENT_BLOCKS`. The
     * non-streaming accumulation loop is the only remaining unbounded buffer, and its
     * size is upstream-controlled.
     *
     * When exceeded, the handler returns 502 "stream interrupted" — the same shape as
     * any other pipeline failure on this leg. Default: 64 MiB.
     */
    maxAggregateBytes: z.number().int().positive().default(64 * 1024 * 1024),
    /**
     * Opt-in to a non-default `providers.codex.baseUrl` or `providers.codex.oauthTokenUrl` host.
     *
     * When false (the default), `subswitch serve` refuses to start if either
     * `providers.codex.baseUrl` or `providers.codex.oauthTokenUrl` points at a host
     * other than the provider's expected defaults (`chatgpt.com` and `auth.openai.com`
     * respectively), because doing so would forward the user's subscription credentials
     * to an untrusted host. `oauthTokenUrl` carries the long-lived refresh token, making
     * it more damaging to expose than the short-lived access token in `baseUrl`.
     *
     * Loopback addresses (127.0.0.0/8, localhost, ::1) are always exempt — the wire-recorder
     * workflow uses `http://127.0.0.1:4142`.
     *
     * Set to `true` only when you intentionally route through a trusted proxy that
     * sits in front of the Codex backend.
     */
    allowInsecureBaseUrl: z.boolean().default(false),
  });

/**
 * The one plain-object predicate in this file.
 *
 * Load-bearing for the own-property walks below (`hasOwnPath`,
 * `detectUnknownProviderKeys`, `detectConfiguredProviders`), which are what keep a
 * polluted prototype from forging or masking a config key (avoids PF-010). Declared
 * here, above its first use, so there is exactly one implementation to harden: a
 * second inline copy would silently not inherit any future tightening.
 */
const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Inject `kind` from the record key before Zod parses each provider block.
 * Zod reads the discriminant before defaults fire, so `kind` cannot carry `.default()`.
 */
const injectKind = (raw: unknown, key: string): unknown => {
  if (isPlainObject(raw) && !Object.hasOwn(raw, "kind")) {
    return { kind: key, ...raw };
  }
  return raw;
};

/**
 * Per-provider file schemas, keyed by ProviderId.
 *
 * `satisfies` against a mapped type over the closed union checks an object literal
 * in BOTH directions: a missing ProviderId key fails the constraint, and a key that
 * is not a ProviderId is an excess property. Adding a provider id without adding a
 * schema — or adding a schema under a misspelled id — is a compile error here.
 */
const PROVIDER_SCHEMAS = {
  codex: z.preprocess((raw) => injectKind(raw, "codex"), CodexProviderSchema).prefault({ kind: "codex" }),
} satisfies { readonly [K in ProviderId]: z.ZodType };

const ProvidersSchema = z.object(PROVIDER_SCHEMAS).prefault({});

const LimitsSchema = z
  .strictObject({
    /** Maximum request body bytes buffered before the Codex routing decision. */
    maxBodyBytes: z.number().int().positive().default(32 * 1024 * 1024),
    /** Interval between SSE ping frames sent to clients during long Codex streams. */
    pingIntervalMs: z.number().int().positive().default(15_000),
    /**
     * @deprecated The admission gate has been removed (ADR-010). Kept in the schema
     * so existing config files do not hard-error on load. Remove from your config.
     */
    maxConcurrentRequests: z.number().int().positive().optional(),
    /**
     * @deprecated The byte-based admission gate has been removed (ADR-010). Kept in
     * the schema so existing config files do not hard-error on load. Remove from
     * your config.
     */
    maxInFlightBytes: z.number().int().positive().optional(),
    /**
     * @deprecated The admission queue has been removed (ADR-010). Kept in the schema
     * so existing config files do not hard-error on load. Remove from your config.
     */
    maxQueueDepth: z.number().int().positive().optional(),
    /**
     * @deprecated The admission queue has been removed (ADR-010). Kept in the schema
     * so existing config files do not hard-error on load. Remove from your config.
     */
    maxQueueWaitMs: z.number().int().positive().optional(),
  })
  .prefault({});

const FileConfigSchema = z.strictObject({
  port: z.number().int().min(1).max(65535).default(DEFAULT_PORT),
  logLevel: z.enum(["debug", "info", "warn", "error"]).default("info"),
  anthropic: AnthropicSchema,
  providers: ProvidersSchema,
  limits: LimitsSchema,
});

/** Raw on-disk config shape — what FileConfigSchema.safeParse() produces. */
export type FileConfig = z.infer<typeof FileConfigSchema>;

/** Raw on-disk shape of a single `providers.<id>` block, for any ProviderId. */
export type ProviderFileConfig = FileConfig["providers"][ProviderId];

// ---------------------------------------------------------------------------
// Resolved Config interface (runtime shape)
// ---------------------------------------------------------------------------

/**
 * The Codex provider's resolved settings — the whole slice a Codex handler needs
 * and nothing more.
 *
 * Provider slices are heterogeneous by design: `oauthTokenUrl` is a detail of the
 * ChatGPT OAuth flow and must not be forced onto a provider that authenticates
 * with a static key or not at all.
 */
export interface CodexProviderConfig {
  readonly baseUrl: string;
  readonly oauthTokenUrl: string;
  /** Tilde-expanded at resolveConfig time. */
  readonly authFile: string;
  readonly userAgent: string;
  readonly aliases: Readonly<Record<string, string>>;
  readonly reasoningCache: {
    readonly maxEntries: number;
    readonly maxBytes: number;
  };
  readonly requestTimeoutMs: number;
  readonly streamIdleTimeoutMs: number;
  readonly maxSseEventBytes: number;
  readonly maxAggregateBytes: number;
  /**
   * Opt-in to a non-default host on `baseUrl` or `oauthTokenUrl`.
   * When false, `serve` refuses to start if either URL points at a foreign host.
   */
  readonly allowInsecureBaseUrl: boolean;
}

/** Provider id → that provider's resolved slice type. One entry per ProviderId. */
interface ProviderConfigShape {
  readonly codex: CodexProviderConfig;
}

/**
 * Resolved per-provider config, keyed by the closed ProviderId union.
 *
 * Mapped over ProviderId rather than written out, so adding an id to PROVIDER_IDS
 * without giving it a ProviderConfigShape entry is a compile error here, at
 * PROVIDER_SCHEMAS, at PROVIDER_RESOLVERS, and at resolveConfig.
 */
export type ProviderConfigs = { readonly [K in ProviderId]: ProviderConfigShape[K] };

/**
 * Resolved runtime config. Hand-written (NOT z.infer) so:
 *  - authFile is always tilde-expanded (resolveConfig applies expandHome).
 *  - the parse-time `kind` discriminant does not leak into the runtime shape.
 */
export interface Config {
  readonly port: number;
  readonly logLevel: LogLevel;
  /**
   * The privileged default leg, not a peer provider: it has no model list, no auth
   * config of its own (the client's credential is forwarded verbatim, applies ADR-002),
   * there is exactly one, and it is always present. Folding it into `providers` for
   * symmetry would give it fields it does not have.
   */
  readonly anthropic: {
    readonly baseUrl: string;
    readonly connectTimeoutMs: number;
    readonly maxUpstreamSockets: number;
    /**
     * Opt-in to a non-default host on `anthropic.baseUrl`.
     * When false, `serve` refuses to start if the URL points at a foreign host.
     */
    readonly allowInsecureBaseUrl: boolean;
  };
  readonly providers: ProviderConfigs;
  readonly limits: {
    readonly maxBodyBytes: number;
    readonly pingIntervalMs: number;
  };
}

export type Limits = Config["limits"];

// ---------------------------------------------------------------------------
// Per-provider config accessor
// ---------------------------------------------------------------------------

/** The provider-neutral slice of config that doctor, health, and the CLI banner need. */
export interface ProviderRuntimeConfig {
  /** Human-facing name for CLI and JSON output (e.g. "Codex"). */
  readonly displayName: string;
  /** Tilde-expanded credential file path. */
  readonly authFile: string;
  /** Provider API base URL. */
  readonly baseUrl: string;
  /** Shell command that obtains this provider's credential, quoted in doctor remediation. */
  readonly loginCommand: string;
  /**
   * Hostname this provider's API is expected to live on.
   *
   * A `baseUrl` pointing anywhere else sends a subscription credential to a
   * third-party host, so buildDeps warns at startup when the two differ. Kept here
   * rather than as a constant in server.ts so the check is per-provider by
   * construction — one provider's default host can never be used to vet another's.
   */
  readonly defaultHost: string;
  /**
   * OAuth token endpoint for credential refresh, when applicable.
   *
   * Present only for providers that authenticate via OAuth (currently Codex). Absent
   * for providers that use static API keys or other schemes. `buildDeps` vets this URL
   * against `defaultOauthHost` and scheme with the same rules as `baseUrl`, because a
   * compromised `oauthTokenUrl` leaks the long-lived refresh token — more damaging than
   * leaking a short-lived access token via a misconfigured `baseUrl`.
   */
  readonly oauthTokenUrl?: string;
  /**
   * Hostname the OAuth token endpoint is expected to live on.
   *
   * Present when `oauthTokenUrl` is present. `buildDeps` warns at startup when the
   * configured `oauthTokenUrl` points at a different host.
   */
  readonly defaultOauthHost?: string;
  /**
   * Opt-in to a non-default host on `baseUrl` or `oauthTokenUrl`.
   *
   * When false, `buildDeps` returns an error (fatal for `serve`) if either URL points at
   * a host other than `defaultHost` / `defaultOauthHost`. Loopback hosts are always exempt.
   */
  readonly allowInsecureBaseUrl: boolean;
}

/**
 * Total map from ProviderId to its config slice.
 *
 * A Record over the closed ProviderId union — NOT a switch with a default arm.
 * Adding a ProviderId without adding an accessor here is a compile error, and
 * there is no unreachable fallback returning empty-string sentinels that callers
 * then have to guard against.
 */
const PROVIDER_CONFIG_ACCESSORS: Readonly<Record<ProviderId, (config: Config) => ProviderRuntimeConfig>> = {
  codex: (config) => ({
    displayName: "Codex",
    authFile: config.providers.codex.authFile,
    baseUrl: config.providers.codex.baseUrl,
    loginCommand: "codex login",
    defaultHost: "chatgpt.com",
    oauthTokenUrl: config.providers.codex.oauthTokenUrl,
    defaultOauthHost: "auth.openai.com",
    allowInsecureBaseUrl: config.providers.codex.allowInsecureBaseUrl,
  }),
};

/**
 * Resolve the config slice for one provider.
 *
 * Single source of truth for "where does provider X keep its credentials and
 * base URL" — doctor, the health endpoint, the serve banner, and `models --json`
 * all read through here so they cannot drift apart.
 */
export const providerConfigFor = (config: Config, id: ProviderId): ProviderRuntimeConfig =>
  PROVIDER_CONFIG_ACCESSORS[id](config);

/**
 * Per-provider alias records, keyed by ProviderId — the shape buildRoutingTable and
 * the models/doctor row builders consume.
 *
 * The single place that answers "which providers contribute aliases, and from where".
 * The routing table and the displayed alias table must agree on that answer, so they
 * read the same function rather than each assembling the record at their call site.
 */
export const aliasesByProvider = (config: Config): AliasesByProvider => ({
  codex: config.providers.codex.aliases,
});

// ---------------------------------------------------------------------------
// Routing topology enumeration
// ---------------------------------------------------------------------------

/**
 * One routing destination that subswitch can forward requests to.
 *
 * Discriminated by `routing`:
 *   - "passthrough" — requests are forwarded verbatim (Anthropic leg; no auth file).
 *   - "registry"    — routing is governed by MODEL_REGISTRY; has an auth file.
 */
export type RoutingDestination =
  | {
      readonly routing: "passthrough";
      readonly id: "anthropic";
      readonly displayName: "Anthropic";
    }
  | {
      readonly routing: "registry";
      readonly id: ProviderId;
      readonly displayName: string;
      /** Tilde-expanded credential file path (from providerConfigFor). */
      readonly authFile: string;
    };

/**
 * All routing destinations in topology order: Anthropic (passthrough) first,
 * then each registered provider in PROVIDER_IDS order.
 *
 * Used by both `buildHealthBody` (server.ts) and `modelsJson` (cli.ts) so the
 * two surfaces cannot disagree on what "all routing destinations" means.
 * Before this helper, each site assembled its own providers list and they drifted:
 * health omitted Anthropic while models --json included it.  (ARCH-04)
 */
export const enumerateDestinations = (config: Config): readonly RoutingDestination[] => [
  { routing: "passthrough", id: "anthropic", displayName: "Anthropic" },
  ...PROVIDER_IDS.map((id): RoutingDestination => {
    const { displayName, authFile } = providerConfigFor(config, id);
    return { routing: "registry", id, displayName, authFile };
  }),
];

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

/**
 * Expand a leading `~` or `~/` to the user's home directory.
 * Exported for use in init.ts (collectPreconditionWarnings auth path).
 */
export const expandHome = (path: string): string =>
  path === "~" ? homedir() : path.startsWith("~/") ? join(homedir(), path.slice(2)) : path;

// ---------------------------------------------------------------------------
// Legacy shape detection
// ---------------------------------------------------------------------------

/**
 * Keys that moved when the config was restructured to `providers.<id>.*`,
 * mapped to their new location. Zod's default object behaviour STRIPS unknown
 * keys, so without this check a pre-restructure config parses successfully and
 * every setting in it is silently discarded — custom aliases vanish, custom
 * baseUrl/authFile/userAgent revert to defaults, and nothing is reported.
 *
 * Silent reversion is the worst failure mode available here, so a legacy key is
 * a hard error naming its replacement rather than a warning.
 */
const LEGACY_KEY_MOVES: readonly (readonly [path: string, replacement: string])[] = [
  ["codex", "providers.codex"],
  ["reasoningCache", "providers.codex.reasoningCache"],
  ["limits.connectTimeoutMs", "anthropic.connectTimeoutMs"],
  ["limits.maxUpstreamSockets", "anthropic.maxUpstreamSockets"],
  ["limits.streamIdleTimeoutMs", "providers.codex.streamIdleTimeoutMs"],
  ["limits.requestTimeoutMs", "providers.codex.requestTimeoutMs"],
  ["limits.maxSseEventBytes", "providers.codex.maxSseEventBytes"],
];

/** Read a dotted path using own-property checks only (prototype-pollution safe). */
const hasOwnPath = (root: Record<string, unknown>, path: string): boolean => {
  let node: unknown = root;
  for (const segment of path.split(".")) {
    if (!isPlainObject(node) || !Object.hasOwn(node, segment)) return false;
    node = node[segment];
  }
  return true;
};

/**
 * Detect keys from the pre-`providers.*` config layout.
 *
 * Pure: no I/O. Returns the legacy paths present, in declaration order, each
 * paired with its replacement. Empty array means the config has no legacy keys.
 */
export const detectLegacyConfigKeys = (
  raw: unknown,
): readonly { readonly path: string; readonly replacement: string }[] => {
  if (!isPlainObject(raw)) return [];
  const found: { readonly path: string; readonly replacement: string }[] = [];
  for (const [path, replacement] of LEGACY_KEY_MOVES) {
    if (hasOwnPath(raw, path)) found.push({ path, replacement });
  }
  // `codex.models` was deleted outright — the routable set now comes from the registry.
  if (hasOwnPath(raw, "codex.models")) {
    found.push({
      path: "codex.models",
      replacement: "(removed — routing now follows the built-in model registry; use providers.codex.aliases for custom names)",
    });
  }
  return found;
};

/**
 * `providers.<id>` blocks whose id is not a ProviderId, in config-file key order.
 *
 * `ProvidersSchema` is a `z.object`, so it STRIPS a block written under an unknown
 * id: a typo (`providers.codexx`) or a block for a provider this build does not ship
 * parses clean and does absolutely nothing. That is the same silent-reversion failure
 * mode as the pre-`providers.*` layout — the operator's file looks configured and the
 * proxy ignores it — and a stripping schema can never report what it discarded, so the
 * check has to run on the RAW object before parsing. (avoids PF-010)
 *
 * Pure: no I/O. Own-property reads only, so a polluted prototype can neither forge a
 * match nor mask one.
 */
export const detectUnknownProviderKeys = (raw: unknown): readonly string[] => {
  if (!isPlainObject(raw)) return [];
  const providers = Object.hasOwn(raw, "providers") ? raw["providers"] : undefined;
  if (!isPlainObject(providers)) return [];
  const known = new Set<string>(PROVIDER_IDS);
  return Object.keys(providers).filter((key) => !known.has(key));
};

// ---------------------------------------------------------------------------
// Deprecated config keys — warn but do not reject (soft-deprecation path)
// ---------------------------------------------------------------------------

/**
 * One entry in the deprecated-key table.
 *
 * A deprecated key differs from a legacy key in that it is still accepted by the
 * schema (as `.optional()`) so existing user configs continue to load — the value
 * is simply not wired into the runtime `Config`. The operator receives a `warn`
 * log and a stderr notice so they know to remove it.
 */
export interface DeprecatedConfigKey {
  /** Dotted config path (e.g. "anthropic.headerTimeoutMs"). */
  readonly path: string;
  /** Human-readable reason to include in the warning. */
  readonly reason: string;
}

/**
 * Keys that are accepted by the schema (so configs don't break) but whose values
 * are no longer wired into the runtime Config. Soft-deprecation: warn on load,
 * do not reject.
 *
 * Six keys are deprecated:
 *   - anthropic.headerTimeoutMs      — relay must never bound headers phase (ADR-010)
 *   - anthropic.streamIdleTimeoutMs  — relay must never bound stream phase (ADR-010)
 *   - limits.maxConcurrentRequests   — admission gate removed (ADR-010)
 *   - limits.maxInFlightBytes        — admission gate removed (ADR-010)
 *   - limits.maxQueueDepth           — admission gate removed (ADR-010)
 *   - limits.maxQueueWaitMs          — admission gate removed (ADR-010)
 */
export const DEPRECATED_KEYS: readonly DeprecatedConfigKey[] = [
  { path: "anthropic.headerTimeoutMs", reason: "the relay no longer bounds the headers phase on a connected client (ADR-010); remove this key" },
  { path: "anthropic.streamIdleTimeoutMs", reason: "the relay no longer bounds the stream-idle phase on a connected client (ADR-010); remove this key" },
  { path: "limits.maxConcurrentRequests", reason: "the admission gate has been removed (ADR-010); remove this key" },
  { path: "limits.maxInFlightBytes", reason: "the admission gate has been removed (ADR-010); remove this key" },
  { path: "limits.maxQueueDepth", reason: "the admission gate has been removed (ADR-010); remove this key" },
  { path: "limits.maxQueueWaitMs", reason: "the admission gate has been removed (ADR-010); remove this key" },
];

/**
 * Return the subset of DEPRECATED_KEYS whose dotted paths are present in the raw
 * config object. Pure: no I/O. Own-property walks only (prototype-pollution safe).
 *
 * Unlike detectLegacyConfigKeys (hard error), deprecated keys are soft: the config
 * loads successfully, but the caller is expected to warn. (avoids PF-010)
 */
export const detectDeprecatedConfigKeys = (raw: unknown): readonly DeprecatedConfigKey[] => {
  if (!isPlainObject(raw)) return [];
  return DEPRECATED_KEYS.filter((entry) => hasOwnPath(raw, entry.path));
};

// ---------------------------------------------------------------------------
// resolveConfig — FileConfig → Config transformation
// ---------------------------------------------------------------------------

/**
 * File slice → resolved slice, one resolver per ProviderId.
 *
 * A Record over the closed union: a new ProviderId with no resolver is a compile
 * error, and the per-key signature correlates each file slice with its own resolved
 * slice, so a resolver cannot be wired to the wrong provider's shape.
 *
 * Each resolver builds its slice field-by-field rather than by spread, so
 * exactOptionalPropertyTypes stays honest and `Config` stays hand-written: a field
 * added to the schema but not to the resolver fails to compile instead of silently
 * riding along untransformed.
 */
const PROVIDER_RESOLVERS: {
  readonly [K in ProviderId]: (file: FileConfig["providers"][K]) => ProviderConfigShape[K];
} = {
  codex: (file) => ({
    baseUrl: file.baseUrl,
    oauthTokenUrl: file.oauthTokenUrl,
    authFile: expandHome(file.authFile),
    userAgent: file.userAgent,
    aliases: file.aliases,
    reasoningCache: file.reasoningCache,
    requestTimeoutMs: file.requestTimeoutMs,
    streamIdleTimeoutMs: file.streamIdleTimeoutMs,
    maxSseEventBytes: file.maxSseEventBytes,
    maxAggregateBytes: file.maxAggregateBytes,
    allowInsecureBaseUrl: file.allowInsecureBaseUrl,
  }),
};

/**
 * Transform a parsed FileConfig into the runtime Config.
 *
 * Pure: no I/O. All effectful operations (file reads, env access) happen in loadConfig.
 *
 * Providers are constructed per key rather than by iterating PROVIDER_IDS: a loop
 * cannot preserve the key→slice-type correlation without a cast, and the cast is
 * exactly the completeness check PROVIDER_RESOLVERS exists to provide.
 * Expands tilde in authFile.
 */
export const resolveConfig = (file: FileConfig): Config => ({
  port: file.port,
  logLevel: file.logLevel,
  anthropic: {
    baseUrl: file.anthropic.baseUrl,
    connectTimeoutMs: file.anthropic.connectTimeoutMs,
    // headerTimeoutMs and streamIdleTimeoutMs are deprecated — parsed by schema
    // so existing configs don't hard-error, but not wired into Config (ADR-010).
    maxUpstreamSockets: file.anthropic.maxUpstreamSockets,
    allowInsecureBaseUrl: file.anthropic.allowInsecureBaseUrl,
  },
  providers: {
    codex: PROVIDER_RESOLVERS.codex(file.providers.codex),
  },
  limits: {
    maxBodyBytes: file.limits.maxBodyBytes,
    pingIntervalMs: file.limits.pingIntervalMs,
    // maxConcurrentRequests, maxInFlightBytes, maxQueueDepth, maxQueueWaitMs are
    // deprecated — admission gate removed (ADR-010). Parsed by schema so existing
    // configs don't hard-error, but not wired into Config.
  },
});

// ---------------------------------------------------------------------------
// loadConfig — discovers, reads, parses, and resolves the config file
// ---------------------------------------------------------------------------

export interface LoadConfigOptions {
  /** Explicit config file path. Takes precedence over SUBSWITCH_CONFIG and the implicit cwd default. */
  readonly configPath?: string;
  /** Injectable file reader. Defaults to `readFileSync`. Used by tests to supply inline config. */
  readonly readFile?: (path: string) => string;
  /** Injectable environment variable map. Defaults to `process.env`. Used by tests. */
  readonly env?: Record<string, string | undefined>;
}

export interface LoadConfigResult {
  readonly config: Config;
  readonly configPath: string;
  readonly fileFound: boolean;
  /**
   * Providers the user explicitly opted into by writing a `providers.<id>` block.
   *
   * Zod fills every provider's defaults, so the resolved `Config` cannot answer
   * "did the user ask for this provider?" — but doctor's severity rules depend on
   * it. A provider the user never configured must stay informational rather than
   * failing the exit code. (avoids PF-006)
   */
  readonly configuredProviders: ReadonlySet<ProviderId>;
  /**
   * Deprecated config keys that were present in the config file.
   *
   * Non-empty when the user has keys in their config that are accepted by the schema
   * (soft-deprecated) but whose values are no longer wired into the runtime Config.
   * The `serve` command logs a `warn` and prints a stderr notice for each entry so
   * the operator knows to remove them. Empty array when no deprecated keys are present.
   */
  readonly deprecatedKeys: readonly DeprecatedConfigKey[];
}

/**
 * Which `providers.<id>` blocks are literally present in the raw config object.
 * Own-property checks only — a JSON-parsed object's inherited keys must never
 * count as user intent.
 */
const detectConfiguredProviders = (raw: unknown): ReadonlySet<ProviderId> => {
  const found = new Set<ProviderId>();
  if (!isPlainObject(raw)) return found;
  const providers = Object.hasOwn(raw, "providers") ? raw["providers"] : undefined;
  if (!isPlainObject(providers)) return found;
  for (const id of PROVIDER_IDS) {
    if (Object.hasOwn(providers, id)) found.add(id);
  }
  return found;
};

/**
 * Load subswitch.config.json (all fields optional) merged over defaults.
 *
 * Path precedence (highest to lowest):
 *   1. explicit `configPath` option
 *   2. `SUBSWITCH_CONFIG` env var (tilde-expanded)
 *   3. implicit `<cwd>/subswitch.config.json`
 *
 * Only the implicit cwd default silently falls back to pure defaults on ENOENT.
 * An explicitly-requested path (option or SUBSWITCH_CONFIG) that is missing is an error.
 */
export const loadConfig = (options: LoadConfigOptions = {}): Result<LoadConfigResult, ProxyError> => {
  const env = options.env ?? process.env;
  const readFile = options.readFile ?? ((path: string) => readFileSync(path, "utf8"));

  let resolvedPath: string;
  let isExplicit: boolean;

  if (options.configPath !== undefined) {
    resolvedPath = options.configPath;
    isExplicit = true;
  } else if (env["SUBSWITCH_CONFIG"] !== undefined && env["SUBSWITCH_CONFIG"] !== "") {
    resolvedPath = expandHome(env["SUBSWITCH_CONFIG"]);
    isExplicit = true;
  } else {
    resolvedPath = join(process.cwd(), "subswitch.config.json");
    isExplicit = false;
  }

  let raw: unknown = {};
  let fileFound = false;

  // Step 1: read the file (isolates ENOENT / permission errors from JSON errors).
  let rawString: string | undefined;
  try {
    rawString = readFile(resolvedPath);
    fileFound = true;
  } catch (cause) {
    const isEnoent = cause instanceof Error && (cause as NodeJS.ErrnoException).code === "ENOENT";
    if (isEnoent && isExplicit) {
      return err({ kind: "translate", message: `config file not found at ${resolvedPath}` });
    }
    if (!isEnoent) {
      return err({ kind: "translate", message: `failed to read config at ${resolvedPath}: ${String(cause)}` });
    }
    // Implicit cwd ENOENT — silently fall back to pure defaults.
  }

  // Step 2: parse JSON (only when a file was successfully read).
  if (rawString !== undefined) {
    try {
      raw = JSON.parse(rawString);
    } catch {
      return err({
        kind: "translate",
        message: `malformed JSON in ${resolvedPath} — fix or delete the file`,
      });
    }
  }

  // Step 3: reject the pre-`providers.*` layout before parsing. Zod strips unknown
  // keys, so a legacy config would otherwise parse clean and silently run on defaults.
  const legacy = detectLegacyConfigKeys(raw);
  if (legacy.length > 0) {
    return err({
      kind: "translate",
      message:
        `outdated config layout in ${resolvedPath} — ` +
        legacy.map((l) => `move \`${l.path}\` to \`${l.replacement}\``).join("; ") +
        `. Edit the file to match subswitch.config.example.json, or delete it to run on defaults.`,
    });
  }

  // Step 3b: reject provider blocks written under an unknown id. Same reason as
  // step 3 — z.object strips them, so the block would silently do nothing.
  const unknownProviders = detectUnknownProviderKeys(raw);
  if (unknownProviders.length > 0) {
    return err({
      kind: "translate",
      message:
        `unknown provider block(s) in ${resolvedPath}: ` +
        unknownProviders.map((key) => `\`providers.${key}\``).join(", ") +
        `. Known providers: ${PROVIDER_IDS.join(", ")}. ` +
        `An unrecognised provider block is ignored entirely, so leaving it in place would silently change nothing.`,
    });
  }

  // Step 4: validate against FileConfigSchema and resolve to runtime Config.
  const parsed = FileConfigSchema.safeParse(raw);
  if (!parsed.success) {
    return err({
      kind: "translate",
      message: `invalid config: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`,
    });
  }

  return ok({
    config: resolveConfig(parsed.data),
    configPath: resolvedPath,
    fileFound,
    configuredProviders: detectConfiguredProviders(raw),
    deprecatedKeys: detectDeprecatedConfigKeys(raw),
  });
};

export const logLevelOf = (config: Config): LogLevel => config.logLevel;
