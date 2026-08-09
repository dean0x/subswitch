import type { IncomingMessage, ServerResponse } from "node:http";

/**
 * Contract every provider handler must satisfy.
 *
 * `handleMessages` receives the already-JSON-parsed body (`parsed: unknown`) so each
 * provider can apply its own schema without paying for a second JSON.parse call.
 *
 * Performance budget: JSON.parse on a 32 MiB body costs ~40 ms — 70–340× the
 * streaming translation overhead of a 5,000-frame response. Parsing at most once
 * per request is load-bearing, not cosmetic. (P4 contract)
 *
 * `rawBody` is kept alongside `parsed` for providers that forward the body untouched
 * (Content-Length preservation) and for `estimateTokens` (rawBody.length).
 */
export interface ProviderHandler {
  handleMessages(
    req: IncomingMessage,
    res: ServerResponse,
    rawBody: Buffer,
    parsed: unknown,
    canonicalModel: string,
  ): Promise<void>;
  handleCountTokens(req: IncomingMessage, res: ServerResponse, rawBody: Buffer): void;
}
