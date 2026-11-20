/**
 * Compile-time proofs for the resolved-config shape.
 *
 * There are no runtime assertions here — `npm run typecheck` is the gate, and it covers
 * this file because tsconfig.json includes `test/**\/*.ts`. Everything lives inside a
 * function that is never called, so the file contributes no test cases and executes
 * nothing under `node --test`.
 *
 * `@ts-expect-error` fails in BOTH directions: it errors if the line below it compiles
 * cleanly (the guarantee was lost), and the line itself errors if the guarantee holds
 * but the annotation is removed. That two-sidedness is what makes these lines a test
 * rather than a comment.
 */
import { withCredential, type Config, type ProviderConfigs, type CodexProviderConfig, type CredentialKindTable, type providerConfigFor } from "../../src/config.js";

const credentialKindsRequireHandlers = (credential: ReturnType<typeof providerConfigFor>): string => {
  // @ts-expect-error a credential kind with no handler must not compile.
  const missingKind: CredentialKindTable<string> = { "oauth-file": (source) => source.authFile };
  void missingKind;

  const complete: CredentialKindTable<string> = {
    "oauth-file": (source) => source.authFile,
    "api-key": (source) => source.envName,
  };
  return withCredential(credential, complete);
};
void credentialKindsRequireHandlers;

const codexSlice: CodexProviderConfig = {
  baseUrl: "https://chatgpt.com/backend-api/codex",
  oauthTokenUrl: "https://auth.openai.com/oauth/token",
  authFile: "/home/user/.codex/auth.json",
  userAgent: "codex_cli_rs/0.144.6",
  aliases: {},
  reasoningCache: { maxEntries: 4096, maxBytes: 64 * 1024 * 1024 },
  requestTimeoutMs: 600_000,
  streamIdleTimeoutMs: 300_000,
  maxSseEventBytes: 4 * 1024 * 1024,
  maxAggregateBytes: 64 * 1024 * 1024,
  allowInsecureBaseUrl: false,
};

const providerConfigsIsTotalOverProviderId = (together: ProviderConfigs["together"]): void => {
  // A record covering every ProviderId is the only accepted shape.
  const complete: ProviderConfigs = { codex: codexSlice, together };
  void complete;

  // @ts-expect-error a ProviderId with no slice must not compile.
  const missingProvider: ProviderConfigs = { codex: codexSlice };
  void missingProvider;

  // @ts-expect-error a key that is not a ProviderId must not compile either — excess-property
  // checking is what stops a slice being wired under a misspelled id, and it is what an
  // index signature on `ProviderConfigs` would silently give away.
  const excessProvider: ProviderConfigs = { ...complete, "not-a-provider": codexSlice };
  void excessProvider;

  // These assertions require both slices and reject extra keys. A new provider ID
  // must also have entries in every provider map in the application.
};
void providerConfigsIsTotalOverProviderId;

const providerSettingsAreReachableOnlyThroughProviders = (config: Config): void => {
  const viaProviders: string = config.providers.codex.baseUrl;
  void viaProviders;

  // @ts-expect-error the top-level `codex` block is gone: a resolved Config keys its
  // provider settings by ProviderId, so no reader can reach back to the old shape.
  const viaTopLevel: string = config.codex.baseUrl;
  void viaTopLevel;

  // Anthropic deliberately stays top-level — it is the privileged default leg, not a peer
  // provider, and it has none of the fields a provider slice carries.
  const anthropicBaseUrl: string = config.anthropic.baseUrl;
  void anthropicBaseUrl;

  // @ts-expect-error ...and it is therefore not addressable as a provider.
  const anthropicAsProvider = config.providers.anthropic;
  void anthropicAsProvider;
};
void providerSettingsAreReachableOnlyThroughProviders;
