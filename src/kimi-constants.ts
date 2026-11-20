// Fixed facts of the Kimi Code CLI sign-in, checked against the public Kimi Code CLI
// source, versions 0.38.0 to 2.7.2. None of them is a config key.
import { createHash } from "node:crypto";

/** The Kimi regions. Each one has its own hosts and its own CLI credential slot. */
export const KIMI_REGIONS = ["global", "mainland-cn"] as const;
export type KimiRegion = (typeof KIMI_REGIONS)[number];

/** The Kimi CLI home when KIMI_CODE_HOME is not set. Subswitch does not read that variable. */
export const KIMI_DEFAULT_HOME = "~/.kimi-code";

/** The folder under the Kimi CLI home that holds the credential slots. */
export const KIMI_CREDENTIALS_FOLDER = "credentials";

/** The hosts and the credential slot of one region. */
export interface KimiRegionProfile {
  /** Host of the Kimi coding API. */
  readonly apiHost: string;
  /** Default base URL of the Kimi coding API. */
  readonly baseUrl: string;
  /** Host of the Kimi sign-in service. */
  readonly oauthHost: string;
  /** Default token URL of the Kimi sign-in service. */
  readonly oauthTokenUrl: string;
  /** File name of the Kimi CLI credential slot, under `<home>/credentials`. */
  readonly credentialFile: string;
}

/**
 * The Kimi CLI slot name for a sign-in origin and API base URL. The CLI uses
 * `kimi-code` for its built-in pair, and otherwise `kimi-code-env-` plus the first
 * 16 hex characters of the SHA-256 of the JSON text of the pair, in this key order.
 */
const credentialFileFor = (oauthHost: string, baseUrl: string): string =>
  oauthHost === "https://auth.kimi.com" && baseUrl === "https://api.kimi.com/coding/v1"
    ? "kimi-code.json"
    : `kimi-code-env-${createHash("sha256").update(JSON.stringify({ oauthHost, baseUrl })).digest("hex").slice(0, 16)}.json`;

const regionProfile = (apiHost: string, oauthHost: string): KimiRegionProfile => {
  const baseUrl = `https://${apiHost}/coding/v1`;
  return {
    apiHost,
    baseUrl,
    oauthHost,
    oauthTokenUrl: `https://${oauthHost}/api/oauth/token`,
    credentialFile: credentialFileFor(`https://${oauthHost}`, baseUrl),
  };
};

/** One profile for each region, so a new region with no hosts does not compile. */
export const KIMI_REGION_TABLE: { readonly [R in KimiRegion]: KimiRegionProfile } = {
  global: regionProfile("api.kimi.ai", "auth.kimi.ai"),
  "mainland-cn": regionProfile("api.kimi.com", "auth.kimi.com"),
};
