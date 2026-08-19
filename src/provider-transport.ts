// Provider-neutral HTTP transport helpers.
// Used by every provider handler; imports nothing provider-specific.

import type { IncomingMessage, ServerResponse } from "node:http";
import { proxyErrorToAnthropic, toAnthropicErrorBody, SYNTHESIZED_HEADER, SYNTHESIZED_MARKER, type ProxyError } from "./errors.js";

/**
 * Send a JSON response, no-op if headers were already sent.
 *
 * Responses from the translating (Codex) leg are synthesized by construction
 * (Codex→Anthropic format translation; no byte is forwarded verbatim), so the
 * marker is always correct here and is included by default so callers cannot
 * forget it.  The Anthropic passthrough leg's upstream responses are NOT marked
 * by this helper — only relay-generated errors on that leg are synthesized.
 *
 * Caller-supplied headers are spread first so the synthesized marker is always
 * last: a caller cannot accidentally or maliciously clear the marker (ADR-010).
 */
export const respondJson = (
  res: ServerResponse,
  status: number,
  body: string,
  extraHeaders: Record<string, string> = {},
): void => {
  if (res.headersSent) return;
  res.writeHead(status, { "content-type": "application/json", ...extraHeaders, [SYNTHESIZED_HEADER]: SYNTHESIZED_MARKER });
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

/**
 * The two bounds on draining an upload the relay has already answered with a
 * synthesized error: how long the drain may run, and how much it may read.
 *
 * Time alone does not bound volume.  Measured on loopback, a client at line rate
 * pushes ~1 GB through the drain in ~215 ms, so a 2 s window admits gigabytes per
 * rejected request.  REJECTED_UPLOAD_DRAIN_BYTES is what makes the volume finite.
 *
 * 32 MiB is the default `limits.maxBodyBytes` — the largest body the relay would
 * have accepted — so a client that merely overshot the cap is never cut off
 * mid-drain.  It is deliberately a constant rather than the configured maxBodyBytes:
 * an operator who lowers the cap to, say, 1 MiB would otherwise have the relay
 * destroy the socket of every client with more than 1 MiB still in flight, which is
 * the RST this helper exists to prevent.
 *
 * The two bounds are pinned by opposite controls: B7 asserts a slow client is closed
 * between 1.5 s and 3 s (time), B10 asserts a line-rate client stops being read far
 * short of its declared length (bytes).
 */
const REJECTED_UPLOAD_DRAIN_MS = 2_000;
const REJECTED_UPLOAD_DRAIN_BYTES = 32 * 1024 * 1024;

/**
 * Drain remaining upload data after a synthesized error so TCP can close with FIN
 * rather than RST, and so the connection is reclaimed rather than wedged.
 *
 * Call this wherever the relay answers a request whose upload is still in flight and
 * whose body it will never read: the inbound 413 and the loopback-gate 403 in
 * server.ts, and the connect-timeout 504 and upstream-error 502 on the Anthropic leg's
 * unbuffered path.  Every one of them leaves the socket with unread inbound bytes.
 * Destroying it then makes the kernel send RST and the client may discard the response
 * it had already received; leaving it alone is no better — Node cannot parse the next
 * request out of a body it never consumed, so the connection is held until
 * `server.requestTimeout` (600 s) with the client stuck mid-upload.  Reading the rest
 * of the upload closes with FIN instead, and keeps the connection reusable when the
 * client finishes promptly.
 *
 * On the passthrough leg the caller must `req.unpipe()` first: the upload is piped
 * into the upstream, and `req._dump()` cannot rescue a stream whose `_consuming` flag
 * is already set.
 *
 * Both bounds destroy the socket outright: past either one the client is not
 * honouring the response and the exchange is dead, so reclaiming it costs nothing the
 * client can still use.  unref() keeps the timer from holding the process open, and
 * the `done` latch keeps it from firing after a clean drain.
 *
 * Every disarm signal is taken from `req`, never from `res`.  `res` emits "close"
 * within a tick or two of the response that precedes this call, so disarming on it
 * would cancel the bound almost as soon as it is armed; `req`'s "end"/"close"/"error"
 * are the signals that mean the upload is finished or gone.
 */
export const drainRejectedUpload = (req: IncomingMessage): void => {
  let done = false;
  const finish = (): void => {
    if (done) return;
    done = true;
    clearTimeout(timer);
  };
  const timer = setTimeout(() => {
    if (!done) req.socket?.destroy();
  }, REJECTED_UPLOAD_DRAIN_MS).unref();
  req.on("end", finish);
  req.on("close", finish);
  req.on("error", finish);
  let drained = 0;
  req.on("data", (chunk: Buffer) => {
    drained += chunk.length;
    if (drained > REJECTED_UPLOAD_DRAIN_BYTES) {
      finish();
      req.socket?.destroy();
    }
  });
  req.resume();
};
