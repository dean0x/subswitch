import { isLoopbackHost, parseTogetherBaseUrl } from "./config.js";
import type { Logger } from "./logger.js";
import { ok, err, type Result } from "./result.js";

export const vetCredentialUrl = (options: {
  url: string;
  path: string;
  expectedHost: string;
  optInKey: string;
  allowOverride: boolean;
  logger: Logger;
  refreshToken?: boolean;
  /** Refuse a plain http URL that is not loopback, even when allowOverride is set. */
  requireHttps?: boolean;
  together?: true;
  events: { insecureBaseUrlScheme: string; baseUrlHostRejected: string; baseUrlOverrideDetected: string };
}): Result<void, string> => {
  const { path, logger, events } = options;
  const url = options.together ? parseTogetherBaseUrl(options.url) : new URL(options.url);
  if (options.together) {
    const defaultPort = url?.protocol === "https:" && !url.port;
    if (url && (isLoopbackHost(url.hostname) || (defaultPort && url.hostname === options.expectedHost))) return ok(undefined);
    const alternate = defaultPort && (url.hostname === "api-inference.together.ai" || url.hostname === "us-api.together.ai");
    if (alternate && options.allowOverride) {
      logger.log("warn", events.baseUrlOverrideDetected);
      return ok(undefined);
    }
    logger.log("error", events.baseUrlHostRejected, { path });
    return err(`${path} is not an allowed Together URL. Use the default host or set "${options.optInKey}": true ` +
      "for api-inference.together.ai or us-api.together.ai in the user configuration or SUBSWITCH_CONFIG.");
  }
  if (!url) return err(`${path} is not a valid URL.`);
  if (isLoopbackHost(url.hostname)) return ok(undefined);
  if (url.protocol !== "https:") {
    if (options.requireHttps) {
      logger.log("error", events.insecureBaseUrlScheme, { path });
      return err(`${path} must use https. Plain http is allowed only for a loopback address.`);
    }
    logger.log("warn", events.insecureBaseUrlScheme);
  }
  if (url.hostname === options.expectedHost && (!url.port || url.port === "443")) return ok(undefined);
  if (!options.allowOverride) {
    logger.log("error", events.baseUrlHostRejected, { path });
    return err(
      `${path} points at '${url.host}' (expected '${options.expectedHost}'). ` +
        `${options.refreshToken ? "Your long-lived refresh token" : "Credentials"} would be sent to an untrusted host. ` +
        `Set "${options.optInKey}": true in the user configuration, or in a file selected with SUBSWITCH_CONFIG, to opt in.`,
    );
  }
  logger.log("warn", events.baseUrlOverrideDetected);
  return ok(undefined);
};
