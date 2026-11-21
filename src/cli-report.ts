import { withCredential, type CredentialKindTable, type ProviderRuntimeConfig, type RoutingDestination } from "./config.js";
import type { ProviderId } from "./models.js";

const BANNER_HOST: CredentialKindTable<string> = {
  "api-key": ({ baseUrl }) => new URL(baseUrl).hostname,
  "native-keychain": ({ baseUrl }) => new URL(baseUrl).hostname,
  "oauth-file": ({ baseUrl }) => {
    try {
      return new URL(baseUrl).hostname;
    } catch {
      return baseUrl;
    }
  },
};

export const formatProviderBanner = (id: ProviderId, modelCount: number, credential: ProviderRuntimeConfig): string => {
  let suffix = "  (not turned on)";
  if (credential.active) {
    const host = withCredential(credential, BANNER_HOST);
    suffix = host !== "" ? `  → ${host}` : "";
  }
  return `  ${id.padEnd(8)}  ${modelCount} model${modelCount === 1 ? "" : "s"}${suffix}`;
};

export const modelProviderRows = (destinations: readonly RoutingDestination[]) =>
  destinations.map(({ id, displayName, routing }) => ({ id, displayName, routing }));
