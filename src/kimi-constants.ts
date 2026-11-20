// Fixed facts of the Kimi Code CLI sign-in, checked against the public Kimi Code CLI
// source, versions 0.38.0 to 2.7.2. None of them is a config key.
import { createHash } from "node:crypto";
import { SUBSWITCH_NAME, SUBSWITCH_VERSION } from "./version.js";

/** The public OAuth client id of the Kimi Code CLI. Each refresh grant names it. */
export const KIMI_OAUTH_CLIENT_ID = "17e5f671-d194-4dfb-9706-5516cb48c098";

/**
 * The identity headers of a Kimi request. They name Subswitch and its version, not the
 * Kimi CLI. `deviceId` is a random id that Subswitch makes once for each process.
 */
export const kimiIdentityHeaders = (deviceId: string): Readonly<Record<string, string>> => ({
  "user-agent": `${SUBSWITCH_NAME}/${SUBSWITCH_VERSION}`,
  "x-msh-platform": SUBSWITCH_NAME,
  "x-msh-version": SUBSWITCH_VERSION,
  "x-msh-device-id": deviceId,
});

/** The Kimi regions. Each one has its own hosts and its own CLI credential slot. */
export const KIMI_REGIONS = ["global", "mainland-cn"] as const;
export type KimiRegion = (typeof KIMI_REGIONS)[number];

/** The Kimi CLI home when KIMI_CODE_HOME is not set. Subswitch does not read that variable. */
export const KIMI_DEFAULT_HOME = "~/.kimi-code";

/** The folder under the Kimi CLI home that holds the credential slots. */
export const KIMI_CREDENTIALS_FOLDER = "credentials";

/**
 * The folder under the Kimi CLI home that holds the CLI lock: an empty lock target file
 * `<slot>` and, while a process holds the lock, the lock folder `<slot>.lock`.
 */
export const KIMI_OAUTH_FOLDER = "oauth";

/** The Kimi CLI takes a lock folder as stale when its mtime is older than this. */
export const KIMI_LOCK_STALE_MS = 5000;

/** The Kimi CLI lock holder updates the lock folder mtime at this interval, half the stale bound. */
export const KIMI_LOCK_HEARTBEAT_MS = 2500;

/**
 * The fields of a Kimi CLI sign-in record, with their JSON types. The CLI writes all six
 * in every version from 0.2.0 to 2.7.2. A record may hold more keys; Subswitch keeps them.
 */
export const KIMI_RECORD_FIELDS = [
  ["access_token", "string"],
  ["refresh_token", "string"],
  ["expires_at", "number"],
  ["scope", "string"],
  ["token_type", "string"],
  ["expires_in", "number"],
] as const;

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
