// Provider-neutral HTTP transport helpers.
// Used by every provider handler; imports nothing provider-specific.

import type { ServerResponse } from "node:http";
import { proxyErrorToAnthropic, toAnthropicErrorBody, type ProxyError } from "./errors.js";

/**
 * Send a JSON response, no-op if headers were already sent.
 */
export const respondJson = (
  res: ServerResponse,
  status: number,
  body: string,
  extraHeaders: Record<string, string> = {},
): void => {
  if (res.headersSent) return;
  res.writeHead(status, { "content-type": "application/json", ...extraHeaders });
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
  return Buffer.concat(parts).toString("utf8").slice(0, maxBytes);
};
