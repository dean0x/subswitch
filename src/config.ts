import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { z } from "zod";
import { type Result, ok, err } from "./result.js";
import type { ProxyError } from "./errors.js";
import type { LogLevel } from "./logger.js";
import { isReservedAnthropicName, PROVIDER_IDS, type ProviderId, type AliasesByProvider } from "./models.js";
import { validClaudeAlias } from "./claude-models.js";
import { AccessProfilesSchema, RoutesSchema, validateExplicitConfig } from "./routing/routing-config.js";
import type { AccessProfile, RoutePolicy } from "./routing/routing-types.js";
import { ownValue } from "./plain-object.js";
import { TOGETHER_API_KEY_ENV, TOGETHER_KEYCHAIN_SERVICE } from "./together-auth.js";
import { TOGETHER_DEFAULT_OUTPUT_CAP } from "./together-request.js";

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
 * IPv4 dotted-quad regex — exactly four decimal groups, each 1-3 digits, anchored
 * at both ends so there is no trailing label.
 *
 * The `^…$` anchors are load-bearing: `127.0.0.1.evil.test` has more than four
 * groups; the `$` anchor stops it from matching the first four and ignoring the
 * rest.  `127.1` has only two groups and likewise fails.
 *
 * Named CONFIG_IPV4_DOTTED to distinguish it from inbound-policy.ts's own copy.
 * Both predicates apply the same strict dotted-quad rule; they are kept separate
 * so neither can be relaxed in one place and silently inherited by the other.
 * (ADR-009, PF-011)
 */
const CONFIG_IPV4_DOTTED = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

/**
 * True when a URL's hostname is a loopback address.
 *
 * Loopback addresses are exempt from the HTTPS requirement because the e2e dev
 * workflow intentionally points `baseUrl` at `http://127.0.0.1:4142`
 * (see `e2e/capture/codex-recorder.ts` and `e2e/README.md`).
 *
 * Accepted forms (exhaustive):
 *   - `localhost` (case-insensitive; `new URL()` normalises to lowercase)
 *   - `::1` or `[::1]` — IPv6 loopback literal.  WHATWG URL `.hostname` preserves
 *     brackets on IPv6 literals (e.g. `new URL("http://[::1]:3000").hostname`
 *     returns `"[::1]"`, not `"::1"`), so both spellings must be accepted.
 *   - `127.x.y.z` — all four decimal octets present, each 0-255, no trailing
 *     labels.  The entire 127.0.0.0/8 block is loopback; exact dotted-quad
 *     form is required (ADR-009 fail-closed contract).
 *
 * Refused (examples):
 *   - `127.0.0.1.evil.test` — attacker-registrable domain prefixed with the
 *     loopback literal.  A prefix test on `127.` admits it, letting a config that
 *     points at that domain start cleanly and send OAuth credentials in
 *     cleartext.  (I-047)
 *   - `127.1` — compressed two-group form; not a valid dotted-quad.
 *   - `2130706433` — decimal representation of 127.0.0.1; not a dotted-quad.
 *   - `foo.localhost`, `localhost.evil.test` — attacker-registrable sub-labels.
 *   - `::ffff:127.x.y.z` (`[::ffff:7f00:1]` after WHATWG normalisation) — IPv4-
 *     mapped loopback.  The hex form produced by `new URL().hostname` is complex
 *     to validate rigorously, and no dev tooling writes this form in config files.
 *     Not accepted; use `http://127.0.0.1` instead.
 *
 * Deliberate divergence from `inbound-policy.ts`'s `isLoopbackHostname`:
 * that predicate operates on attacker-controlled Host/Origin headers from the
 * wire and its caller (`hostnameFromAuthority`) strips IPv6 brackets before the
 * comparison.  `isLoopbackHost` receives hostnames from `new URL().hostname`,
 * which preserves brackets, so the two helpers cannot be unified without silently
 * breaking one of the two trust boundaries.  Both are strict and documented here
 * and in inbound-policy.ts; neither inherits relaxations from the other.
 * (ADR-009, PF-011)
 *
 * Exported so `buildDeps` can apply the same logic without duplication.
 */
export const isLoopbackHost = (hostname: string): boolean => {
  // WHATWG URL .hostname preserves brackets on IPv6 literals ("[::1]" not "::1").
  // Strip them before comparison so both direct calls and URL-sourced calls work.
  const bare =
    hostname.startsWith("[") && hostname.endsWith("]")
      ? hostname.slice(1, -1)
      : hostname;

  if (bare === "localhost" || bare === "::1") return true;
  const octets = CONFIG_IPV4_DOTTED.exec(bare);
  if (octets === null) return false;
  if (octets[1] !== "127") return false;
  return octets.slice(1).every((octet) => Number(octet) <= 255);
};

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
  "must use https:// (or http:// to 127.x.y.z/localhost/[::1] for local dev); " +
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
     * DNS resolution and TCP connection-establishment budget for the Anthropic
     * leg (milliseconds).  The timer is armed directly on the socket inside the
     * `'socket'` event handler, before DNS resolves (not via
     * `ClientRequest.setTimeout`, which defers internally and cannot bound this
     * phase — PF-019).  The budget therefore covers the full connect window:
     * DNS lookup plus TCP SYN/ACK.
     *
     * On `'connect'` the timer is disarmed outright: neither the headers phase
     * nor the stream phase is bounded, because the relay must never terminate a
     * request the origin was about to answer (ADR-010). A connect that has not
     * completed is a connection the origin has not yet seen, which is what makes
     * this bound legitimate.
     *
     * On HTTPS connections, `'connect'` fires after TCP establishment but before
     * the TLS handshake, so TLS negotiation is NOT covered by this budget.
     *
     * Has no effect on reused pooled sockets (no connect phase).
     */
    connectTimeoutMs: z.number().int().positive().default(10_000),
    /**
     * Maximum sockets in the keep-alive pool for the Anthropic passthrough.
     *
     * 256 gives comfortable headroom over the realistic peak of ~100 concurrent
     * sub-agents. Past this ceiling `http.Agent` queues internally, which costs
     * latency rather than producing a synthesized status — the native-looking
     * failure mode ADR-010 prefers.
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

// Both sides are bounded to 200 chars: an alias target flows into the outbound request
// body and the `route` log field, so an unbounded one would be a config-side hole in the
// request-side limits. Those limits are: ModelPeekSchema caps a plain `model` at 200
// chars; a `together:` name of any length reaches the resolver, which accepts its id only
// under the 200-char Together id grammar; the server clears `model` for an invalid
// qualified name before it logs; and the logger strips control characters from each value.
const AliasesSchema = z
  .record(z.string().min(1).max(200), z.string().min(1).max(200))
  .refine((aliases) => !Object.keys(aliases).some(isReservedAnthropicName), {
    message:
      "alias keys matching 'claude-*' or Claude Code model names (sonnet, opus, haiku, fable, best, inherit) are rejected — they would silently misroute Anthropic traffic to Codex",
  })
  .refine((aliases) => !Object.values(aliases).some(isReservedAnthropicName), {
    message:
      "alias targets matching 'claude-*' or Claude Code model names (sonnet, opus, haiku, fable, best, inherit) are rejected — the target becomes routable and would silently misroute Anthropic traffic to Codex",
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
      .strictObject({
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
     * `maxBufferedBodyBytes`, and the translator now has `MAX_CONTENT_BLOCKS`. The
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

export const TOGETHER_DEFAULT_HOST = "api.together.ai";
const MIB = 1024 * 1024;

/**
 * Parse a Together base URL that can carry the paid key. Return the URL only for HTTPS,
 * or for HTTP to a loopback host, with no userinfo, query, fragment, backslash or
 * whitespace; else return undefined. The startup host check also uses this parser.
 */
export const parseTogetherBaseUrl = (raw: string): URL | undefined => {
  if (!/^https?:\/\/[^/?#\\\s]+/i.test(raw) || /[?#\\\s]/.test(raw) || /^https?:\/\/[^/]*@/i.test(raw)) return;
  if (!URL.canParse(raw)) return;
  const url = new URL(raw);
  if (url.username || url.password) return;
  if (url.protocol === "https:" || (url.protocol === "http:" && isLoopbackHost(url.hostname))) return url;
};

const TogetherProviderSchema = z.strictObject({
  kind: z.literal("together"),
  baseUrl: z.string().refine((raw) => parseTogetherBaseUrl(raw) !== undefined, {
    message: "Use HTTPS (or HTTP on loopback) without userinfo, query or fragment in the user configuration or SUBSWITCH_CONFIG.",
  }).default(`https://${TOGETHER_DEFAULT_HOST}/v1`),
  allowInsecureBaseUrl: z.boolean().default(false),
  aliases: AliasesSchema,
  outputCap: z.number().int().positive().default(TOGETHER_DEFAULT_OUTPUT_CAP),
  requestTimeoutMs: z.number().int().positive().max(2_147_483_647).default(600_000),
  streamIdleTimeoutMs: z.number().int().positive().max(2_147_483_647).default(300_000),
  maxSseEventBytes: z.number().int().positive().default(4 * MIB),
  maxAggregateBytes: z.number().int().positive().default(64 * MIB),
  reasoningCache: z.strictObject({
    maxEntries: z.number().int().positive().default(1024),
    maxBytes: z.number().int().positive().default(16 * MIB),
    maxTurnBytes: z.number().int().positive().max(MIB).default(MIB),
  }).prefault({}),
});

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
  together: z.preprocess((raw) => injectKind(raw, "together"), TogetherProviderSchema).prefault({ kind: "together" }),
} satisfies { readonly [K in ProviderId]: z.ZodType };

const ProvidersSchema = z.object(PROVIDER_SCHEMAS).prefault({});

const LimitsSchema = z
  .strictObject({
    /**
     * Maximum request body bytes the relay buffers before the routing decision.
     *
     * Three consequences:
     *   1. Bodies at or below this size: fully buffered, JSON-parsed, routed by `model` field.
     *   2. Bodies above this size bound for Anthropic: streamed verbatim — the prefix is
     *      scanned for the `model` field, and the rest is piped to `api.anthropic.com`.
     *   3. Bodies above this size bound for a translated route (Codex): answered
     *      `413 request_too_large` — on that leg subswitch is the origin and cannot translate
     *      a body it cannot hold.
     */
    maxBufferedBodyBytes: z.number().int().positive().default(32 * 1024 * 1024),
    /** Interval between SSE ping frames sent to clients during long Codex streams. */
    pingIntervalMs: z.number().int().positive().default(15_000),
  })
  .prefault({});

const ClaudeProviderSchema = z.strictObject({
  enabled: z.boolean().default(false),
  baseUrl: z.url().refine(requireHttpsOrLoopback, { message: HTTPS_REQUIRED_MESSAGE }).default("https://api.anthropic.com"),
  oauthTokenUrl: z.url().refine(requireHttpsOrLoopback, { message: HTTPS_REQUIRED_MESSAGE }).default("https://platform.claude.com/v1/oauth/token"),
  configDir: z.string().min(1).optional(),
  authFile: z.string().min(1).optional(),
  aliases: z.record(z.string().min(1).max(200), z.string().min(1).max(200)).refine(value =>
    Object.entries(value).every(([key, target]) => validClaudeAlias(key, target)),
  { message: "Claude aliases must target claude-* IDs and must not claim OpenAI model names" }).default({}),
  allowInsecureBaseUrl: z.boolean().default(false),
  requestTimeoutMs: z.number().int().positive().default(600_000),
  streamIdleTimeoutMs: z.number().int().positive().default(300_000),
  maxSseEventBytes: z.number().int().positive().default(4 * 1024 * 1024),
  maxAggregateBytes: z.number().int().positive().default(64 * 1024 * 1024),
  reasoningCache: z.strictObject({ maxEntries: z.number().int().positive().default(4096), maxBytes: z.number().int().positive().default(64 * 1024 * 1024) }).prefault({}),
}).superRefine((value, ctx) => {
  for (const key of ["baseUrl", "oauthTokenUrl"] as const) {
    const url = new URL(value[key]);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash)
      ctx.addIssue({ code: "custom", path: [key], message: "use an HTTP(S) URL without credentials, query, or fragment" });
  }
}).prefault({});
export type ClaudeProviderConfig = z.infer<typeof ClaudeProviderSchema>;

/** Native Codex ingress, with opt-in Claude routing. */
const CodexIngressSchema = z.strictObject({
  enabled: z.boolean().default(false),
  subscriptionBaseUrl: z.url().refine(requireHttpsOrLoopback, { message: HTTPS_REQUIRED_MESSAGE })
    .default("https://chatgpt.com/backend-api/codex"),
  apiBaseUrl: z.url().refine(requireHttpsOrLoopback, { message: HTTPS_REQUIRED_MESSAGE })
    .default("https://api.openai.com/v1"),
  connectTimeoutMs: z.number().int().positive().default(10_000),
  maxUpstreamSockets: z.number().int().positive().default(256),
  allowInsecureBaseUrl: z.boolean().default(false),
  claude: ClaudeProviderSchema,
}).superRefine((value, ctx) => {
  for (const key of ["subscriptionBaseUrl", "apiBaseUrl"] as const) {
    const url = new URL(value[key]);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
      ctx.addIssue({ code: "custom", path: [key], message: "use an HTTP(S) base URL without credentials, query, or fragment" });
    }
  }
}).prefault({});

export type CodexIngressConfig = z.infer<typeof CodexIngressSchema>;

const FileConfigSchema = z.strictObject({
  configVersion: z.literal(2).optional(),
  accessProfiles: AccessProfilesSchema,
  routes: RoutesSchema,
  port: z.number().int().min(1).max(65535).default(DEFAULT_PORT),
  logLevel: z.enum(["debug", "info", "warn", "error"]).default("info"),
  anthropic: AnthropicSchema,
  providers: ProvidersSchema,
  limits: LimitsSchema,
  codexIngress: CodexIngressSchema,
}).superRefine((file, ctx) => {
  if ((Object.keys(file.accessProfiles).length || Object.keys(file.routes).length) && file.configVersion !== 2)
    ctx.addIssue({ code: "custom", message: "explicit profiles/routes require configVersion: 2" });
  for (const route of Object.values(file.routes)) {
    for (const target of [route.primary, ...route.fallbacks]) {
      const profile = ownValue(file.accessProfiles, target.profile);
      const aliases = profile?.provider === "codex" ? file.providers.codex.aliases :
        profile?.provider === "claude" ? file.codexIngress.claude.aliases : {};
      const alias = ownValue(aliases, target.model);
      if (alias) {
        if (ownValue(aliases, alias)) ctx.addIssue({ code: "custom", message: "alias chains and cycles are forbidden in explicit routes" });
        else target.model = alias;
      }
    }
  }
  for (const name of Object.keys(file.routes)) {
    if (Object.hasOwn(file.providers.codex.aliases, name) || Object.hasOwn(file.codexIngress.claude.aliases, name))
      ctx.addIssue({ code: "custom", message: `${name}: conflicting legacy/explicit declaration; remove the legacy alias to migrate` });
  }
  for (const message of validateExplicitConfig(file.accessProfiles, file.routes, isLoopbackHost))
    ctx.addIssue({ code: "custom", message });
});

/** Raw on-disk config shape — what FileConfigSchema.safeParse() produces. */
export type FileConfig = z.infer<typeof FileConfigSchema>;

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
  readonly together: TogetherProviderConfig;
}

export type TogetherProviderConfig = Readonly<Omit<z.infer<typeof TogetherProviderSchema>, "kind">>;

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
  readonly configVersion?: 2;
  readonly accessProfiles?: Readonly<Record<string, AccessProfile>>;
  readonly routes?: Readonly<Record<string, RoutePolicy>>;
  readonly port: number;
  readonly logLevel: LogLevel;
  readonly codexIngress: CodexIngressConfig;
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
    readonly maxBufferedBodyBytes: number;
    readonly pingIntervalMs: number;
  };
}

export type Limits = Config["limits"];

// ---------------------------------------------------------------------------
// Per-provider config accessor
// ---------------------------------------------------------------------------

/** Credential source and host policy. This data does not contain tokens. */
export type Credential =
  | {
      readonly kind: "oauth-file";
      /** Tilde-expanded credential file path. */
      readonly authFile: string;
      /** Shell command that obtains this provider's credential. */
      readonly loginCommand: string;
      readonly baseUrl: string;
      readonly defaultHost: string;
      readonly oauthTokenUrl: string;
      readonly defaultOauthHost: string;
      /** Opt-in to a non-default host on either credential-bearing URL. */
      readonly allowInsecureBaseUrl: boolean;
    }
  | {
      readonly kind: "api-key";
      readonly baseUrl: string;
      readonly defaultHost: string;
      readonly allowInsecureBaseUrl: boolean;
      readonly envName: typeof TOGETHER_API_KEY_ENV;
      readonly keychainService: typeof TOGETHER_KEYCHAIN_SERVICE;
    };

type CredentialKind = Credential["kind"];

export type CredentialKindTable<R> = {
  [K in CredentialKind]: (credential: Extract<Credential, { kind: K }>) => R;
};

export const withCredential = <R>(credential: Credential, table: CredentialKindTable<R>): R => {
  switch (credential.kind) {
    case "oauth-file": return table["oauth-file"](credential);
    case "api-key": return table["api-key"](credential);
  }
};

/** The provider-neutral slice of config that doctor, health, and the CLI banner need. */
export type ProviderRuntimeConfig = Credential & {
  /** Human-facing name for CLI and JSON output (e.g. "Codex"). */
  readonly displayName: string;
};

export const codexCredentialFor = (
  provider: CodexProviderConfig, loginCommand = "codex login",
): Extract<Credential, { kind: "oauth-file" }> => ({
  kind: "oauth-file",
  authFile: provider.authFile,
  baseUrl: provider.baseUrl,
  loginCommand,
  defaultHost: "chatgpt.com",
  oauthTokenUrl: provider.oauthTokenUrl,
  defaultOauthHost: "auth.openai.com",
  allowInsecureBaseUrl: provider.allowInsecureBaseUrl,
});

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
    ...codexCredentialFor(config.providers.codex),
  }),
  together: ({ providers: { together } }) => ({
    displayName: "Together",
    kind: "api-key",
    baseUrl: together.baseUrl,
    defaultHost: TOGETHER_DEFAULT_HOST,
    allowInsecureBaseUrl: together.allowInsecureBaseUrl,
    envName: TOGETHER_API_KEY_ENV,
    keychainService: TOGETHER_KEYCHAIN_SERVICE,
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
  together: config.providers.together.aliases,
});

// ---------------------------------------------------------------------------
// Routing topology enumeration
// ---------------------------------------------------------------------------

/**
 * One routing destination that subswitch can forward requests to.
 *
 * Discriminated by `routing`:
 *   - "passthrough" — requests are forwarded verbatim (Anthropic leg; no auth file).
 *   - "registry"    — MODEL_REGISTRY controls routing; has a credential source.
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
      readonly credential: Credential;
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
    const { displayName, ...credential } = providerConfigFor(config, id);
    return { routing: "registry", id, displayName, credential };
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
 * A key that MOVED to a new dotted path — tell the operator where it went.
 * Rendered as: move `<path>` to `<to>`
 */
type LegacyKeyMove = { readonly kind: "moved"; readonly path: string; readonly to: string };

/**
 * A key that was REMOVED entirely — tell the operator why and which version.
 * Rendered as: delete `<path>` — <reason>
 */
type LegacyKeyRemoval = { readonly kind: "removed"; readonly path: string; readonly reason: string };

/** Discriminated union for an entry in the legacy-key detection table. */
export type LegacyKeyEntry = LegacyKeyMove | LegacyKeyRemoval;

/**
 * Render one legacy-key entry as a single operator instruction.
 *
 * Both gates that reject a legacy config — `loadConfig` and init's pre-write check
 * in init.ts — render through here, so the instruction a user gets from `subswitch
 * init` is byte-identical to the one `subswitch serve` gave them. The exhaustive
 * `never` arm makes a new `kind` a compile error instead of a silent fallthrough to
 * a "delete" instruction.
 */
export const renderLegacyKeyEntry = (entry: LegacyKeyEntry): string => {
  switch (entry.kind) {
    case "moved":
      return `move \`${entry.path}\` to \`${entry.to}\``;
    case "removed":
      return `delete \`${entry.path}\` — ${entry.reason}`;
    default: {
      // Exhaustive check — compiler enforces that all LegacyKeyEntry arms are handled.
      const _exhaustive: never = entry;
      void _exhaustive;
      return "";
    }
  }
};

/**
 * Keys that moved when the config was restructured to `providers.<id>.*`,
 * plus keys that were removed outright. Zod's default object behaviour STRIPS
 * unknown keys, so without this check a pre-restructure config parses
 * successfully and every setting in it is silently discarded — custom aliases
 * vanish, custom baseUrl/authFile/userAgent revert to defaults, and nothing is
 * reported.
 *
 * Silent reversion is the worst failure mode available here, so a legacy key is
 * a hard error naming its replacement (or removal reason) rather than a warning.
 */
const LEGACY_KEY_ENTRIES: readonly LegacyKeyEntry[] = [
  { kind: "moved", path: "codex", to: "providers.codex" },
  { kind: "moved", path: "reasoningCache", to: "providers.codex.reasoningCache" },
  { kind: "moved", path: "limits.connectTimeoutMs", to: "anthropic.connectTimeoutMs" },
  { kind: "moved", path: "limits.maxUpstreamSockets", to: "anthropic.maxUpstreamSockets" },
  { kind: "moved", path: "limits.streamIdleTimeoutMs", to: "providers.codex.streamIdleTimeoutMs" },
  { kind: "moved", path: "limits.requestTimeoutMs", to: "providers.codex.requestTimeoutMs" },
  { kind: "moved", path: "limits.maxSseEventBytes", to: "providers.codex.maxSseEventBytes" },
  // Removed in 0.3.0 — hard-error so an operator upgrading from 0.2.0 knows to delete them.
  // A row earns its place here only if a RELEASED config could carry the key; anything
  // else is caught by strict parsing with Zod's unrecognized-key message.
  { kind: "removed", path: "anthropic.streamIdleTimeoutMs", reason: "the relay does not bound the stream-idle phase on a connected client, removed in 0.3.0 (ADR-010)" },
  { kind: "removed", path: "limits.maxConcurrentRequests", reason: "the admission gate was removed in 0.3.0 (ADR-010)" },
  // Renamed in 0.4.0: the cap no longer applies to Anthropic-bound bodies (ADR-010) — it
  // now controls only how much the relay buffers for routing, and over-window Anthropic
  // traffic streams through rather than being rejected.
  { kind: "moved", path: "limits.maxBodyBytes", to: "limits.maxBufferedBodyBytes" },
  // Kept last: the message this table renders is quoted verbatim in the 0.2.0 changelog,
  // and codex.models is its closing clause.
  { kind: "removed", path: "codex.models", reason: "the routable set now comes from the built-in model registry (use providers.codex.aliases for custom names), removed in 0.2.0 (ADR-006)" },
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
 * Detect keys from the pre-`providers.*` config layout, plus keys that were
 * removed entirely.
 *
 * Pure: no I/O. Returns the legacy paths present, in declaration order, each
 * tagged with its kind (moved or removed). Empty array means the config is
 * clean.
 */
export const detectLegacyConfigKeys = (raw: unknown): readonly LegacyKeyEntry[] => {
  if (!isPlainObject(raw)) return [];
  const found: LegacyKeyEntry[] = [];
  for (const entry of LEGACY_KEY_ENTRIES) {
    if (hasOwnPath(raw, entry.path)) found.push(entry);
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
  together: ({ kind: _kind, ...file }) => file,
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
  ...(file.configVersion === 2 ? { configVersion: 2 as const, accessProfiles: file.accessProfiles, routes: file.routes } : {}),
  port: file.port,
  logLevel: file.logLevel,
  codexIngress: file.codexIngress,
  anthropic: {
    baseUrl: file.anthropic.baseUrl,
    connectTimeoutMs: file.anthropic.connectTimeoutMs,
    maxUpstreamSockets: file.anthropic.maxUpstreamSockets,
    allowInsecureBaseUrl: file.anthropic.allowInsecureBaseUrl,
  },
  providers: {
    codex: PROVIDER_RESOLVERS.codex(file.providers.codex),
    together: PROVIDER_RESOLVERS.together(file.providers.together),
  },
  limits: {
    maxBufferedBodyBytes: file.limits.maxBufferedBodyBytes,
    pingIntervalMs: file.limits.pingIntervalMs,
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
  readonly globalConfigPath?: string | false;
  readonly homeDir?: string;
  readonly cwd?: string;
  /** When false, use only the user or explicit config port, then the built-in default. */
  readonly allowProjectPort?: boolean;
}

/**
 * The user configuration path. XDG_CONFIG_HOME counts only when it is an absolute path:
 * the XDG Base Directory spec says that a relative value is invalid and must be ignored,
 * and that an empty value means unset. A relative value would otherwise resolve against
 * the current folder. Every reader of the user configuration path calls this function.
 */
export const userConfigPath = (env: Record<string, string | undefined> = process.env, homeDir = env["HOME"] ?? homedir()): string => {
  const xdgConfigHome = env["XDG_CONFIG_HOME"];
  const configHome = xdgConfigHome !== undefined && isAbsolute(xdgConfigHome) ? xdgConfigHome : join(homeDir, ".config");
  return join(configHome, "subswitch", "config.json");
};

/** Own properties only; arrays and scalars replace, nested configuration objects merge. */
export function mergeConfigObjects(base: Record<string, unknown>, overlay: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries([...new Set([...Object.keys(base), ...Object.keys(overlay)])].map(key => {
    const value = Object.hasOwn(overlay, key) ? overlay[key] : base[key];
    return [key, Object.hasOwn(overlay, key) && isPlainObject(base[key]) && isPlainObject(value) ? mergeConfigObjects(base[key], value) : value];
  }));
}

export interface LoadConfigResult {
  /** Loaded source paths in precedence order (user defaults, then project). */
  readonly configPaths: readonly string[];
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
 * Dotted keys that a project `subswitch.config.json` can not set: explicit profiles
 * and routes, the whole Together block (it selects a paid key and its host), every
 * sign-in address, every key that selects a credential file or folder, and every
 * `allowInsecureBaseUrl` opt-in. Only the user configuration or a
 * file selected with SUBSWITCH_CONFIG sets them, so a file in the current folder can
 * not change where subswitch sends a sign-in or which credential it loads.
 *
 * Matched with `hasOwnPath`, so an inherited key can not forge or hide a match.
 * Provider keys come from PROVIDER_IDS: a new provider with these key names is
 * refused without an edit here.
 */
const PROJECT_REFUSED_KEYS: readonly string[] = [
  "accessProfiles",
  "routes",
  "providers.together",
  "anthropic.baseUrl",
  "anthropic.allowInsecureBaseUrl",
  ...PROVIDER_IDS.flatMap(id => [
    `providers.${id}.baseUrl`,
    `providers.${id}.oauthTokenUrl`,
    `providers.${id}.authFile`,
    `providers.${id}.allowInsecureBaseUrl`,
  ]),
  "codexIngress.subscriptionBaseUrl",
  "codexIngress.apiBaseUrl",
  "codexIngress.allowInsecureBaseUrl",
  "codexIngress.claude.baseUrl",
  "codexIngress.claude.oauthTokenUrl",
  "codexIngress.claude.authFile",
  "codexIngress.claude.configDir",
  "codexIngress.claude.allowInsecureBaseUrl",
];

/**
 * Load subswitch.config.json (all fields optional) merged over defaults.
 *
 * Path precedence (highest to lowest):
 *   1. explicit `configPath` option
 *   2. `SUBSWITCH_CONFIG` env var (tilde-expanded)
 *   3. implicit user config merged under `<cwd>/subswitch.config.json` (permitted project fields win)
 *
 * Profiles, routes, the Together block, sign-in addresses, credential file and folder
 * keys, and the `allowInsecureBaseUrl` opt-ins (PROJECT_REFUSED_KEYS) require a user
 * or explicit config. Project files that declare any of these keys fail before the
 * merge, even for empty values.
 * With allowProjectPort false, the project port does not participate in the merge.
 * Only implicit user/project files silently fall back to defaults on ENOENT.
 * Explicit config selection bypasses the user/project merge.
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
    resolvedPath = join(options.cwd ?? process.cwd(), "subswitch.config.json");
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

  const globalPath = options.globalConfigPath === false ? undefined :
    options.globalConfigPath ?? userConfigPath(env, options.homeDir);
  const isProject = !isExplicit && resolvedPath !== globalPath;
  if (isProject && isPlainObject(raw)) {
    const project = raw;
    const matched = PROJECT_REFUSED_KEYS.filter(path => hasOwnPath(project, path));
    // Name only the outermost refused key: `providers.together` covers its own sub-keys.
    const forbidden = matched.filter(path => !matched.some(outer => path.startsWith(`${outer}.`)));
    if (forbidden.length > 0) {
      return err({
        kind: "translate",
        message: `${forbidden.join(", ")} not allowed in project configuration at ${resolvedPath}. ` +
          `Put these keys in the user configuration at ${globalPath ?? userConfigPath(env, options.homeDir)} ` +
          `or select a file with SUBSWITCH_CONFIG.`,
      });
    }
  }

  const sources: { path: string; raw: unknown }[] = fileFound ? [{ path: resolvedPath, raw }] : [];
  if (isProject && options.allowProjectPort === false && isPlainObject(raw)) {
    raw = Object.fromEntries(Object.entries(raw).filter(([key]) => key !== "port"));
  }
  let loadedGlobal: string | undefined;
  if (!isExplicit && globalPath !== undefined) {
    if (globalPath !== resolvedPath) {
      let globalText: string | undefined;
      try { globalText = readFile(globalPath); }
      catch (cause) {
        if (!(cause instanceof Error && (cause as NodeJS.ErrnoException).code === "ENOENT"))
          return err({ kind: "translate", message: `cannot read user configuration at ${globalPath}` });
      }
      if (globalText !== undefined) {
        let global: unknown;
        try { global = JSON.parse(globalText); }
        catch { return err({ kind: "translate", message: `malformed JSON in ${globalPath} — fix or delete the file` }); }
        if (!isPlainObject(global)) return err({ kind: "translate", message: `configuration at ${globalPath} must be a JSON object` });
        sources.unshift({ path: globalPath, raw: global });
        if (isPlainObject(raw)) raw = mergeConfigObjects(global, raw);
        loadedGlobal = globalPath;
      }
    }
  }

  for (const source of sources) {
  // Step 3: reject the pre-`providers.*` layout before parsing. Zod strips unknown
  // keys, so a legacy config would otherwise parse clean and silently run on defaults.
  const legacy = detectLegacyConfigKeys(source.raw);
  if (legacy.length > 0) {
    return err({
      kind: "translate",
      message:
        `unsupported config keys in ${source.path} — ` +
        legacy.map(renderLegacyKeyEntry).join("; ") +
        `. Edit the file to match subswitch.config.example.json, or delete it to run on defaults.`,
    });
  }

  // Step 3b: reject provider blocks written under an unknown id. Same reason as
  // step 3 — z.object strips them, so the block would silently do nothing.
  const unknownProviders = detectUnknownProviderKeys(source.raw);
  if (unknownProviders.length > 0) {
    return err({
      kind: "translate",
      message:
        `unknown provider block(s) in ${source.path}: ` +
        unknownProviders.map((key) => `\`providers.${key}\``).join(", ") +
        `. Known providers: ${PROVIDER_IDS.join(", ")}. ` +
        `An unrecognised provider block is ignored entirely, so leaving it in place would silently change nothing.`,
    });
  }

  }

  // Step 4: validate against FileConfigSchema and resolve to runtime Config.
  const parsed = FileConfigSchema.safeParse(raw);
  if (!parsed.success) {
    return err({
      kind: "translate",
      message: `invalid config: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")} (sources: ${sources.map(source => source.path).join(" + ") || resolvedPath})`,
    });
  }

  return ok({
    config: resolveConfig(parsed.data),
    configPaths: sources.map(source => source.path),
    configPath: !fileFound && loadedGlobal ? loadedGlobal : resolvedPath,
    fileFound: fileFound || loadedGlobal !== undefined,
    configuredProviders: detectConfiguredProviders(raw),
  });
};

export const logLevelOf = (config: Config): LogLevel => config.logLevel;
