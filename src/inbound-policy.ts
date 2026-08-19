// Inbound HTTP transport policy for the relay's own http.Server.
//
// This module owns one concern: how the relay treats a client connection BEFORE
// (and independently of) any routing decision — the server-level timeout and
// counter knobs, and the response taxonomy for the client errors those knobs and
// Node's HTTP parser produce.  Nothing here knows about providers, models, or
// upstreams; server.ts owns the composition root, dispatch, and body ingestion.
//
// It is deliberately a SINGLE entry point.  PF-021's lesson is that the timeouts
// and the response taxonomy for their expiry are one policy, not two: applying
// the tuning without the clientError handler reproduces PF-021's original defect
// verbatim (a bodyless, unlogged, unmarked reply the relay never authored), while
// attaching the handler without the tuning shapes 408s around Node's 60 s
// headersTimeout default instead of the value this relay chose.  Exporting the two
// halves separately let a caller apply either one alone; exporting only
// applyInboundPolicy makes that unrepresentable.

import net from "node:net";
import type http from "node:http";
import type { Duplex } from "node:stream";
import { toAnthropicErrorBody, SYNTHESIZED_HEADER, SYNTHESIZED_MARKER, type AnthropicErrorType } from "./errors.js";
import type { Logger } from "./logger.js";

/**
 * HTTP server tuning knobs — applied once in createProxyServer.
 *
 * Exported so tests can apply the same values to test servers (no fixture drift).
 *
 * requestTimeout (600 s): Anthropic's own server-side ceiling for long-running
 * completions; the relay must never fire before the origin.
 * headersTimeout (120 s): maximum time to receive all request headers — protects
 * against slow-loris header attacks while allowing realistic clients.
 * keepAliveTimeout (300 s): matches the Anthropic keep-alive pool's idle-socket
 * timeout so the server does not close sockets the pool would still reuse.
 * maxRequestsPerSocket: 0 disables Node's built-in per-socket request ceiling
 * (its default is 0 as of Node 19, but explicit is safer).
 * maxHeaderSize: 64 KiB — generous for any legitimate Anthropic request but
 * bounds the header-overflow attack surface.
 *
 * `maxHeaderSize` is the one member applyInboundPolicy does not apply: it is
 * constructor-only (there is no `http.Server` property for it), so server.ts
 * passes it into `http.createServer({...})` at construction.
 */
export const SERVER_TUNING = {
  requestTimeout: 600_000,
  headersTimeout: 120_000,
  keepAliveTimeout: 300_000,
  maxRequestsPerSocket: 0,
  maxHeaderSize: 64 * 1024,
} as const;

/**
 * The response for one `clientError` code: the status Node itself would have
 * sent, shaped into the Anthropic error taxonomy.
 *
 * Registering a `clientError` listener SUPPRESSES Node's canned reply entirely,
 * so every status Node would have chosen must be reproduced here — a code this
 * table does not name silently becomes the 400 fallback.
 *
 * `ERR_HTTP_REQUEST_TIMEOUT` is the load-bearing entry.  Measured on Node 22.22,
 * BOTH `headersTimeout` and `requestTimeout` expiry arrive here under that code,
 * and Node's own reply for it is `408 Request Timeout`.  Letting it fall into the
 * 400 arm would emit a status neither Node nor the origin produces for a slow
 * client, and would additionally misdiagnose a slow request as a malformed one —
 * a relay-invented status on a connection that is merely slow (ADR-010).
 *
 * PF-021 records this response as un-interceptable.  That holds for Node's
 * DEFAULT reply only: attaching this listener does intercept it, which is
 * precisely why the status has to be restated rather than inherited.
 */
const CLIENT_ERROR_RESPONSES: Readonly<
  Record<string, { readonly status: number; readonly reason: string; readonly type: AnthropicErrorType; readonly message: string }>
> = {
  HPE_HEADER_OVERFLOW: {
    status: 431,
    reason: "Request Header Fields Too Large",
    type: "request_too_large",
    message: "request headers too large",
  },
  ERR_HTTP_REQUEST_TIMEOUT: {
    status: 408,
    reason: "Request Timeout",
    type: "invalid_request_error",
    message: "request timed out before it was fully received",
  },
};

/** Fallback for a genuine parse failure (HPE_INVALID_METHOD, HPE_INVALID_VERSION, …). */
const MALFORMED_REQUEST_RESPONSE = {
  status: 400,
  reason: "Bad Request",
  type: "invalid_request_error",
  message: "malformed request",
} as const;

/**
 * Apply the relay's inbound transport policy to `server`: the post-construction
 * tuning knobs and the `clientError` handler that owns the responses those knobs
 * produce.  One call, so the two halves cannot be applied independently (PF-021).
 *
 * clientError handling: malformed requests, header overflow and inbound timeouts
 * get an Anthropic-shaped response body and the synthesized marker.
 *
 * Node's built-in clientError response is bodyless (just a status line) and
 * bypasses the request listener entirely, so it can never carry our marker or
 * content-type.  Registering our own `clientError` handler replaces Node's
 * canned response with one that matches the Anthropic error shape — while
 * preserving the status Node would have sent (see CLIENT_ERROR_RESPONSES).
 *
 * Socket state guard: if the socket is not writable, or bytes have already been
 * written for THIS request, destroy it silently — there is nothing useful we can
 * send.  That is also the branch a slow-but-complete upload lands in: Node still
 * reports the request timeout after the handler has replied, and the reply must
 * not be corrupted.
 */
export const applyInboundPolicy = (server: http.Server, logger: Logger): void => {
  // Apply server-level HTTP tuning knobs. These must be set after construction
  // (not in the createServer options object) to avoid Node version differences
  // in which options are recognized.  SERVER_TUNING is exported so tests can
  // apply the same values to their own test servers.
  server.requestTimeout = SERVER_TUNING.requestTimeout;
  server.headersTimeout = SERVER_TUNING.headersTimeout;
  server.keepAliveTimeout = SERVER_TUNING.keepAliveTimeout;
  server.maxRequestsPerSocket = SERVER_TUNING.maxRequestsPerSocket;

  /**
   * `socket.bytesWritten` when the most recent response on that socket FINISHED.
   *
   * Taking ownership of the clientError response is per-CONNECTION, so the guard on
   * the shaped reply has to be per-REQUEST (PF-021).  `bytesWritten` is cumulative
   * over the socket's lifetime, so on its own it cannot answer "has anything been
   * written for THIS request": after the first response on a keep-alive connection
   * it is permanently non-zero, and this branch makes reuse the steady state
   * (keepAliveTimeout 300 s, maxRequestsPerSocket 0).  Subtracting the baseline
   * recovers the per-request count.
   *
   * Node's own guard reads `_httpMessage._header`; both are private, so the baseline
   * is the public equivalent.  A WeakMap keyed on the socket holds no socket alive.
   *
   * The socket is captured as a local rather than read from `res.socket` inside the
   * listener: Node registers its own 'finish' listener (which detaches the socket)
   * when the request is created, i.e. before this one, so by the time this runs
   * `res.socket` is already null.
   *
   * Only 'finish' stamps the baseline — never 'close'.  'finish' means the response
   * was written in full, which is exactly the condition under which the socket is
   * clean for a new request; a response aborted mid-write must keep the old baseline
   * so the guard below still sees unflushed bytes and destroys.
   */
  const writtenAtLastResponse = new WeakMap<Duplex, number>();
  server.on("request", (req, res) => {
    const socket = req.socket;
    res.on("finish", () => { writtenAtLastResponse.set(socket, socket.bytesWritten); });
  });

  // `socket` is annotated as the Duplex @types/node actually declares.  Listener
  // parameters are bivariant, so the previous `net.Socket` annotation was an
  // assertion in all but name — invisible to a grep for `as` — and a Duplex that is
  // not a net.Socket would have made `bytesWritten` undefined, failed `=== 0`, and
  // taken the entire 400/408/431 taxonomy dark with no compile error.  Narrowing
  // with `instanceof` makes that case an explicit, deliberate destroy instead.
  //
  // `NodeJS.ErrnoException` widens `Error` only with optional members, so it is
  // satisfied by any Error the runtime passes — it removes the cast without
  // repeating the unsound narrowing.
  server.on("clientError", (err: NodeJS.ErrnoException, socket: Duplex) => {
    if (!(socket instanceof net.Socket) || !socket.writable) {
      socket.destroy();
      return;
    }
    // fresh socket        → no baseline → 0, and bytesWritten is 0 → reply
    // reused, idle        → baseline === bytesWritten               → reply
    // response mid-write  → bytesWritten > baseline                 → destroy
    if (socket.bytesWritten !== (writtenAtLastResponse.get(socket) ?? 0)) {
      socket.destroy();
      return;
    }
    const code = err.code ?? "";
    const { status, reason, type, message } = CLIENT_ERROR_RESPONSES[code] ?? MALFORMED_REQUEST_RESPONSE;
    logger.log("warn", "client_error", { ...(code !== "" ? { errorCode: code } : {}), status });
    const body = toAnthropicErrorBody(type, message);
    const head =
      `HTTP/1.1 ${status} ${reason}\r\n` +
      `content-type: application/json\r\n` +
      `content-length: ${Buffer.byteLength(body)}\r\n` +
      `${SYNTHESIZED_HEADER}: ${SYNTHESIZED_MARKER}\r\n` +
      `connection: close\r\n` +
      `\r\n`;
    socket.end(head + body);
    socket.destroy();
  });
};
