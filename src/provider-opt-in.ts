import type { ServerResponse } from "node:http";
import { toAnthropicErrorBody } from "./errors.js";
import type { ProviderHandler } from "./provider-handler.js";
import { respondJson } from "./provider-transport.js";

/**
 * The handler for a provider whose `providers.<key>` block is not in the user
 * configuration or in a file selected with SUBSWITCH_CONFIG.
 *
 * Every request, count_tokens included, gets the same fixed local 400. The reply
 * names only the block to add; it does not echo the request. The handler reads no
 * credential, file or network, and it does not read the request or its body.
 * A project file can not set the block, so the text never names one.
 */
export const notOptedInHandler = (displayName: string, key: string): ProviderHandler => {
  const body = toAnthropicErrorBody("invalid_request_error",
    `${displayName} is not turned on. Add a "providers.${key}" block to the user configuration, ` +
    "or to a file selected with SUBSWITCH_CONFIG, then restart subswitch.");
  const reply = (res: ServerResponse): void => respondJson(res, 400, body);
  return {
    handleMessages: async (_req, res) => { reply(res); },
    handleCountTokens: (_req, res) => { reply(res); },
  };
};
