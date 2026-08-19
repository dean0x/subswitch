// Inbound HTTP transport policy for the relay's own http.Server.
//
// This module owns one concern: how the relay treats a client connection BEFORE
// (and independently of) any routing decision — the server-level timeout and
// counter knobs, the response taxonomy for the client errors those knobs and
// Node's HTTP parser produce, and the loopback Host/Origin gate that decides
// whether a request is addressed to this relay at all.  Nothing here knows about
// providers, models, or upstreams; server.ts owns the composition root, dispatch,
// and body ingestion.
//
// The gate and the clientError handler are independent layers on the same
// connection and never interact: clientError fires for requests Node's parser
// could not turn into a request at all (no request listener, no ServerResponse),
// while the gate runs inside dispatch on a fully parsed request.
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

// ---------------------------------------------------------------------------
// Loopback Host/Origin gate
// ---------------------------------------------------------------------------

/** Which check refused the request. Carried into the log, never into the body. */
export type HostGateRejection = "missing_host" | "foreign_host" | "foreign_origin";

export type HostGateVerdict =
  | { readonly kind: "allow" }
  | {
      readonly kind: "reject";
      readonly reason: HostGateRejection;
      /** Fixed, client-visible text. Never contains any client-supplied value. */
      readonly message: string;
      /** The offending value, sanitised and capped — for the operator's log only. */
      readonly observed: string;
    };

/**
 * The client-visible message for each rejection.
 *
 * Fixed strings by construction: reflecting the rejected Host or Origin back into
 * the body would hand an attacker an echo surface on an endpoint that answers
 * before any authentication, and would put wire-controlled text through the one
 * response the relay authors itself.  The value goes to the operator's log
 * (sanitised) and nowhere else.
 */
const HOST_GATE_MESSAGES: Readonly<Record<HostGateRejection, string>> = {
  missing_host: "request carries no Host header naming this relay's loopback listener",
  foreign_host: "request Host is not a loopback address this relay answers for",
  foreign_origin: "request Origin is not a loopback origin",
};

/**
 * Characters an authority (or a serialized origin) can legitimately contain.
 * Everything else — control characters, quotes, whitespace, `=` — becomes `?`
 * before the value reaches a log line.
 *
 * The logger's own renderToken strips controls and quotes ambiguous tokens, so
 * this is defence in depth; the point here is that the sanitised value is also
 * safe for any other sink (a file, a dashboard, a grep pipeline).
 */
const UNSAFE_AUTHORITY_CHARS = /[^a-z0-9.:/[\]_-]/g;
const OBSERVED_MAX_CHARS = 64;

const sanitizeObserved = (raw: string): string =>
  raw.slice(0, OBSERVED_MAX_CHARS).toLowerCase().replace(UNSAFE_AUTHORITY_CHARS, "?");

/**
 * `::ffff:127.0.0.1` is the IPv4-mapped IPv6 spelling of `127.0.0.1` — the same
 * address, so it unwraps to the dotted quad and is judged by the same rule.
 * Only a well-formed mapped IPv4 literal unwraps; `::ffff:evil.test` does not match.
 */
const IPV4_MAPPED = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/;
const IPV4_DOTTED = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

/**
 * True when `hostname` names the loopback interface — for a hostname taken off
 * the wire.
 *
 * Deliberately NOT `config.ts`'s `isLoopbackHost`, and the difference is the whole
 * point of this gate.  That predicate accepts any name beginning `127.` because it
 * judges an OPERATOR-authored config URL, where a prefix test is a convenience.
 * A Host header is ATTACKER-authored, and `127.0.0.1.evil.test` starts with `127.`
 * — that is the exact shape of a public rebinding domain (nip.io, sslip.io, or any
 * attacker-registered equivalent), so reusing the lenient predicate would have
 * shipped a gate that admits precisely the attack it exists to stop.  Pinned by
 * the "starts with a loopback literal" controls in both test files.
 *
 * Accepted: `localhost`, `::1`, and all of 127.0.0.0/8 in dotted-quad form.
 * Everything else — `foo.localhost`, `localhost.`, `127.1`, `2130706433` — is
 * refused.  Browsers normalise every one of those to a spelling in the accepted
 * set before they reach the Host header, so refusing them costs no real client.
 */
const isLoopbackHostname = (hostname: string): boolean => {
  if (hostname === "localhost" || hostname === "::1") return true;
  const octets = IPV4_DOTTED.exec(hostname);
  if (octets === null) return false;
  if (octets[1] !== "127") return false;
  return octets.slice(1).every((octet) => Number(octet) <= 255);
};

/**
 * Extract the hostname from an HTTP authority (`Host` header value or the
 * host part of an Origin), or undefined when it is not parseable as one.
 *
 * Returning undefined rather than a best guess is the load-bearing part: a naive
 * `replace(/:\d+$/, "")` turns the bare IPv6 literal `::1` into `:`, and any
 * "strip after the last colon" rule can be steered by a crafted value.  Anything
 * this function cannot read confidently is refused by the caller.
 */
const hostnameFromAuthority = (authority: string): string | undefined => {
  const value = authority.trim().toLowerCase();
  if (value === "") return undefined;

  if (value.startsWith("[")) {
    const close = value.indexOf("]");
    if (close < 0) return undefined;
    const trailing = value.slice(close + 1);
    if (trailing !== "" && !/^:\d+$/.test(trailing)) return undefined;
    const inner = value.slice(1, close);
    return inner === "" ? undefined : (IPV4_MAPPED.exec(inner)?.[1] ?? inner);
  }

  const firstColon = value.indexOf(":");
  if (firstColon < 0) return value;
  // Two or more colons without brackets is a bare IPv6 literal (RFC 3986 requires
  // brackets when a port follows, so there is no port to strip).  Judge it whole:
  // splitting on a colon here is what would turn `::1` into `:`.
  if (value.indexOf(":", firstColon + 1) >= 0) return IPV4_MAPPED.exec(value)?.[1] ?? value;

  const host = value.slice(0, firstColon);
  const port = value.slice(firstColon + 1);
  if (host === "" || !/^\d*$/.test(port)) return undefined;
  return host;
};

/** True when a serialized origin (`http://localhost:3000`, `null`, …) is loopback. */
const isLoopbackOrigin = (origin: string): boolean => {
  let parsed: URL;
  try {
    parsed = new URL(origin.trim());
  } catch {
    // Includes the opaque origin `null` (sandboxed iframe, cross-origin redirect)
    // and the ", "-joined value Node produces for a duplicated Origin header.
    return false;
  }
  const hostname = hostnameFromAuthority(parsed.hostname);
  return hostname !== undefined && isLoopbackHostname(hostname);
};

/**
 * Decide whether a request is addressed to this relay, from its headers alone.
 *
 * subswitch binds 127.0.0.1 and requires no authentication, so reachability is its
 * only access control — and DNS rebinding defeats reachability.  A page on
 * `http://evil.test:4141` whose name resolves to 127.0.0.1 is SAME-ORIGIN with the
 * relay as far as the browser is concerned: the fetch needs no credential the page
 * cannot supply, and the response is fully readable.  `gpt-*` names route to the
 * Codex leg, which attaches the operator's `~/.codex/auth.json`.  The one thing the
 * attacker cannot change is the `Host` header the browser puts on the request: it
 * names the domain the page was loaded from, never the address it resolved to.
 *
 * Two independent checks, Host first:
 *  - Host must name a loopback address.  This is the control that stops rebinding.
 *  - Origin, when present, must be a loopback origin.  Defence in depth: a browser
 *    always sends Origin on a cross-origin request, while Claude Code and curl send
 *    none, so an absent Origin is allowed and only a present, non-loopback one is
 *    refused.  This catches plain cross-origin CSRF, where the response is opaque
 *    to the attacker but the request still bills the operator's subscription.
 *
 * Rejecting is compatible with the relay's transparency rule (applies ADR-010): a
 * request whose Host names a domain the relay does not serve is one the origin
 * would never have received, so refusing it invents no behaviour the origin would
 * have had to produce — and the refusal itself uses 403 / permission_error, a
 * status and type Anthropic emits.
 *
 * Total and pure: headers in, verdict out — no I/O, no throw.
 */
export const hostGateVerdict = (headers: http.IncomingHttpHeaders): HostGateVerdict => {
  // Node keeps the FIRST Host header when a request carries several (measured on
  // Node 22), so a smuggled second one cannot override a rejected first.
  const hostHeader = headers.host;
  const reject = (reason: HostGateRejection, raw: string): HostGateVerdict => ({
    kind: "reject",
    reason,
    message: HOST_GATE_MESSAGES[reason],
    observed: sanitizeObserved(raw),
  });

  if (hostHeader === undefined || hostHeader.trim() === "") {
    // Reachable on HTTP/1.0, which has no Host requirement; Node rejects an
    // HTTP/1.1 request with no Host itself, before the request listener runs.
    return reject("missing_host", hostHeader ?? "");
  }
  const hostname = hostnameFromAuthority(hostHeader);
  if (hostname === undefined || !isLoopbackHostname(hostname)) return reject("foreign_host", hostHeader);

  const origin = headers.origin;
  if (origin !== undefined && origin !== "" && !isLoopbackOrigin(origin)) return reject("foreign_origin", origin);

  return { kind: "allow" };
};

/**
 * HTTP server tuning knobs — applied once in createProxyServer.
 *
 * Exported so tests can apply the same values to test servers (no fixture drift).
 *
 * The member names (`requestTimeout`, `headersTimeout`, `keepAliveTimeout`,
 * `maxRequestsPerSocket`, `maxHeaderSize`) mirror `http.Server`'s own property
 * names verbatim; they are unrelated to the `providers.*.requestTimeoutMs`
 * config knobs.
 *
 * requestTimeout (600 s): Anthropic's own server-side ceiling for long-running
 * completions; the relay must never fire before the origin.
 * headersTimeout (120 s): maximum time to receive all request headers — protects
 * against slow-loris header attacks while allowing realistic clients.
 * keepAliveTimeout (300 s): guards against PF-018. Node's 5 s default can close
 * an idle inbound keep-alive socket at the exact moment a client starts writing
 * its next POST on it; the client gets ECONNRESET on a non-idempotent request
 * the relay cannot retry. 300 s makes that window negligible for long-running
 * agents.
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
 * Prototype-safe lookup: returns the mapped response for a known error code, or
 * MALFORMED_REQUEST_RESPONSE as the fallback.
 *
 * A bare bracket read (`CLIENT_ERROR_RESPONSES[code]`) reaches Object.prototype
 * for reserved names ("constructor", "__proto__"), returning a truthy value that
 * is not a response descriptor; `?? MALFORMED_REQUEST_RESPONSE` does not fire
 * and the socket receives `HTTP/1.1 undefined undefined`.  Object.hasOwn avoids
 * the prototype chain (avoids PF-021's pattern of hidden prototype paths;
 * matches Object.hasOwn usage at config.ts:hasOwnPath and models.ts:byAlias).
 *
 * @internal Exported for unit testing only.
 */
export const responseForClientError = (code: string): { readonly status: number; readonly reason: string; readonly type: AnthropicErrorType; readonly message: string } =>
  Object.hasOwn(CLIENT_ERROR_RESPONSES, code)
    // Non-null assertion: Object.hasOwn guarantees the key is a direct property.
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    ? CLIENT_ERROR_RESPONSES[code]!
    : MALFORMED_REQUEST_RESPONSE;

/**
 * Apply the relay's inbound transport policy to `server`: the post-construction
 * tuning knobs and the `clientError` handler that owns the responses those knobs
 * produce.  One call, so the two halves cannot be applied independently (PF-021).
 *
 * Idempotent: a second call on the same server is a no-op.  Calling `server.on`
 * twice would register two `clientError` listeners and double-reply into the
 * same socket.
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

/** Servers that have already been configured — prevents double-registration. */
const appliedServers = new WeakSet<http.Server>();

export const applyInboundPolicy = (server: http.Server, logger: Logger): void => {
  if (appliedServers.has(server)) return;
  appliedServers.add(server);

  // Apply the four post-construction timer/counter knobs.  These have
  // corresponding http.Server properties; maxHeaderSize is constructor-only
  // (no http.Server property) and is passed in the options object at
  // http.createServer in server.ts — the one SERVER_TUNING member not applied
  // here.  SERVER_TUNING is exported so tests can apply the same values to their
  // own test servers.
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
    const { status, reason, type, message } = responseForClientError(code);
    logger.log("warn", "client_error", { ...(code !== "" ? { errorCode: code } : {}), status });
    const body = toAnthropicErrorBody(type, message);
    const head =
      `HTTP/1.1 ${status} ${reason}\r\n` +
      `content-type: application/json\r\n` +
      `content-length: ${Buffer.byteLength(body)}\r\n` +
      `${SYNTHESIZED_HEADER}: ${SYNTHESIZED_MARKER}\r\n` +
      `connection: close\r\n` +
      `\r\n`;
    // Flush the response before destroying; without the callback, destroy() can
    // race the kernel buffer and truncate the body before the client reads it.
    socket.end(head + body, () => socket.destroy());
  });
};
