import type { IncomingMessage, ServerResponse } from "node:http";
import { toAnthropicErrorBody } from "./errors.js";
import { createRawHttpForwarder, type PassthroughOptions as RawOptions, type ForwardedBody } from "./raw-http-passthrough.js";

export type { ForwardedBody } from "./raw-http-passthrough.js";
export type PassthroughOptions = Omit<RawOptions, "errorBody" | "logPath" | "events">;
export type AnthropicForwarder = ((req: IncomingMessage, res: ServerResponse, body?: ForwardedBody) => void) & { close?(): void };

/** Existing Claude-facing transport, with its original errors and connect-only timeout. */
export const createAnthropicForwarder = (options: PassthroughOptions): AnthropicForwarder =>
  createRawHttpForwarder({
    ...options,
    limitContext: options.limitContext ?? { provider: "claude", product: "anthropic-unknown", protocol: "messages" },
    errorBody: (message) => toAnthropicErrorBody("api_error", message),
    logPath: (req) => req.url ?? "/",
    events: { timeout: "anthropic_upstream_timeout", error: "anthropic_upstream_error" },
  });
