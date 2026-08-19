// Provider-neutral HTTP transport helpers.
// Used by every provider handler; imports nothing provider-specific.

import type { ServerResponse } from "node:http";
import { proxyErrorToAnthropic, toAnthropicErrorBody, SYNTHESIZED_HEADER, SYNTHESIZED_MARKER, type ProxyError } from "./errors.js";

/**
 * Send a JSON response, no-op if headers were already sent.
 *
 * Every response emitted by a provider handler is synthesized by the relay
 * (the codex leg translates Codex→Anthropic; no byte is forwarded verbatim).
 * The synthesized marker is therefore always correct here and is included by
 * default so callers cannot forget it.
 */
export const respondJson = (
  res: ServerResponse,
  status: number,
  body: string,
  extraHeaders: Record<string, string> = {},
): void => {
  if (res.headersSent) return;
  res.writeHead(status, { "content-type": "application/json", [SYNTHESIZED_HEADER]: SYNTHESIZED_MARKER, ...extraHeaders });
  res.end(body);
};

/**
 * Map a ProxyError to an Anthropic-shaped HTTP response.
 */
export const respondProxyError = (res: ServerResponse, error: ProxyError): void => {
  const mapped = proxyErrorToAnthropic(error);
  respondJson(res, mapped.status, toAnthropicErrorBody(mapped.type, error.message));
};

/**
 * Build a backpressure-aware SSE frame writer bound to `res` and `signal`.
 *
 * Returns a function that resolves once the frame is handed to the socket, or
 * once waiting becomes pointless. Every wait is bounded by one of three exits —
 * 'drain', response 'close', or the abort signal — so a client that stops reading
 * without closing cannot hold the request open past its timeout.
 *
 * Lives here rather than inline in a handler so tests exercise the real function.
 * A hand-copied replica in a test keeps passing after the original drifts, which
 * is exactly how the already-aborted case below went unnoticed.
 */
export const createFrameWriter = (
  res: ServerResponse,
  signal: AbortSignal,
): ((frame: string) => Promise<void>) => (frame) =>
  new Promise((resolve) => {
    if (res.destroyed || res.write(frame)) {
      resolve();
      return;
    }
    // The signal may ALREADY be aborted here — a total/idle timer can fire while
    // an earlier frame was draining. addEventListener on an aborted signal never
    // dispatches, so registering below without this check waits forever: the
    // request's cleanup never runs and resources associated with the request are held
    // for the life of the process. Checked after res.write so an in-flight frame still goes out.
    if (signal.aborted) {
      resolve();
      return;
    }
    const detach = (): void => {
      res.off("drain", onDrain);
      res.off("close", onClose);
      signal.removeEventListener("abort", onAbort);
    };
    const onDrain = (): void => { detach(); resolve(); };
    const onClose = (): void => { detach(); resolve(); };
    const onAbort = (): void => { detach(); resolve(); };
    res.once("drain", onDrain);
    res.once("close", onClose);
    signal.addEventListener("abort", onAbort, { once: true });
  });

/**
 * Read at most `maxBytes` bytes from a WHATWG ReadableStream body.
 *
 * Safe to call with `null` (returns `""`). Cancels the reader after reading so
 * the upstream connection is not held open. The caller receives a UTF-8 string
 * truncated to `maxBytes` — a truncated body may not be valid JSON; the caller
 * must handle that possibility.
 */
export const readBoundedText = async (body: Response["body"], maxBytes: number): Promise<string> => {
  if (body === null) return "";
  const reader = body.getReader();
  const parts: Buffer[] = [];
  let total = 0;
  try {
    while (total < maxBytes) {
      const { done, value } = await reader.read();
      if (done) break;
      parts.push(Buffer.from(value));
      total += value.byteLength;
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  // .slice(0, maxBytes) operates on a JS string, so the unit here is UTF-16 code
  // units, not bytes. This is intentional: the enforcing byte bound is the read
  // loop above (total < maxBytes on value.byteLength). The slice is a belt-and-
  // suspenders trim for multi-byte sequences that straddle the chunk boundary and
  // inflate the string past maxBytes — tolerable because the caller already guards
  // against truncated JSON.
  return Buffer.concat(parts).toString("utf8").slice(0, maxBytes);
};
