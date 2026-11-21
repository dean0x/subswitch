import { isLoopbackHost, parseCredentialUrl } from "./config.js";
import type { Logger } from "./logger.js";
import { ok, err, type Result } from "./result.js";

export const vetCredentialUrl = (options: {
  url: string;
  path: string;
  expectedHost: string;
  /** The config key that allows another host. Without one, the host error names no key. */
  optInKey?: string;
  allowOverride: boolean;
  logger: Logger;
  refreshToken?: boolean;
  /** Refuse a plain http URL that is not loopback, even when allowOverride is set. */
  requireHttps?: boolean;
  together?: true;
  /** Require the default host and port. Do not admit loopback or a host override. */
  requireDefaultHost?: true;
  events: { insecureBaseUrlScheme: string; baseUrlHostRejected: string; baseUrlOverrideDetected: string };
}): Result<void, string> => {
  const { path, logger, events } = options;
  const url = options.together ? parseCredentialUrl(options.url) : URL.parse(options.url);
  if (options.together) {
    const defaultPort = url?.protocol === "https:" && !url.port;
    if (url && (isLoopbackHost(url.hostname) || (defaultPort && url.hostname === options.expectedHost))) return ok(undefined);
    const alternate = defaultPort && (url.hostname === "api-inference.together.ai" || url.hostname === "us-api.together.ai");
    if (alternate && options.allowOverride) {
      logger.log("warn", events.baseUrlOverrideDetected);
      return ok(undefined);
    }
    logger.log("error", events.baseUrlHostRejected, { path });
    const optIn = options.optInKey === undefined ? "" : ` or set "${options.optInKey}": true ` +
      "for api-inference.together.ai or us-api.together.ai in the user configuration or SUBSWITCH_CONFIG";
    return err(`${path} is not an allowed Together URL. Use the default host${optIn}.`);
  }
  if (!url) return err(`${path} is not a valid URL.`);
  const loopback = isLoopbackHost(url.hostname);
  if (loopback && !options.requireDefaultHost) return ok(undefined);
  if (url.protocol !== "https:") {
    if (options.requireHttps) {
      logger.log("error", events.insecureBaseUrlScheme, { path });
      return err(options.requireDefaultHost ? `${path} must use https.` :
        `${path} must use https. Plain http is allowed only for a loopback address.`);
    }
    logger.log("warn", events.insecureBaseUrlScheme);
  }
  if (!loopback && url.hostname === options.expectedHost && (!url.port || url.port === "443")) return ok(undefined);
  if (options.requireDefaultHost || !options.allowOverride) {
    logger.log("error", events.baseUrlHostRejected, { path });
    if (options.requireDefaultHost) return err(`${path} must use the default host on port 443.`);
    const optIn = options.optInKey === undefined ? "Use the default host." :
      `Set "${options.optInKey}": true in the user configuration, or in a file selected with SUBSWITCH_CONFIG, to opt in.`;
    return err(
      `${path} points at '${url.host}' (expected '${options.expectedHost}'). ` +
        `${options.refreshToken ? "Your long-lived refresh token" : "Credentials"} would be sent to an untrusted host. ${optIn}`,
    );
  }
  logger.log("warn", events.baseUrlOverrideDetected);
  return ok(undefined);
};
