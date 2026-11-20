/**
 * e2e/capture/gemini-recorder.ts
 *
 * NOT-PRODUCTION: Dev-only wire-capture recorder. The build compiles src only.
 * Run via: ./node_modules/.bin/tsx e2e/capture/gemini-recorder.ts
 * Point CLOUD_CODE_URL at http://127.0.0.1:4143 (or GEMINI_RECORDER_PORT).
 * GEMINI_RECORDER_UPSTREAM accepts only a loopback HTTP(S) origin for tests.
 *
 * **NEVER COMMIT CAPTURED OUTPUT.**
 * **Derived fixtures MUST use fabricated values.**
 *
 * The relay forwards credentials on the wire. It prints shapes to stdout only.
 * It decodes a gzip body for the view only and forwards the wire bytes unchanged.
 */

import * as http from "node:http";
import * as https from "node:https";
import { pathToFileURL } from "node:url";
import * as zlib from "node:zlib";
import { BoundedCapture } from "../../src/bounded-capture.js";
import { isLoopbackHost } from "../../src/config.js";
import { isPlainObject } from "../../src/plain-object.js";
import { filterRawHeaders, HOP_BY_HOP, setRawRequestHeaders } from "../../src/raw-http-passthrough.js";
import { redactedValue, renderCaptureToken } from "./codex-recorder.js";
import type { RecorderOutput } from "./codex-recorder.js";

const LISTEN_HOST = "127.0.0.1";
const LISTEN_PORT = 4143;
const DEFAULT_UPSTREAM = "https://daily-cloudcode-pa.googleapis.com";
const UPSTREAM_REFUSAL = "gemini-recorder: upstream override must be an HTTP(S) loopback origin";
const UPSTREAM_FAILURE = "upstream connection error";
const UPSTREAM_IDLE_MS = 120_000;
const MAX_LINE_CHARS = 8_192;
const MAX_VALUE_CHARS = 64;
const MAX_CAPTURE_BYTES = 4 * 1024 * 1024;
/** A small gzip body can decode to a very large one; the view stops decoding past this cap. */
const MAX_DECODED_BYTES = 64 * 1024 * 1024;
const MAX_SSE_DETAIL_LINES = 200;
const MAX_DEPTH = 10;
const MAX_FIELDS = 100;
const MAX_OBJECT_KEYS = 24;
const MAX_ARRAY_ITEMS = 4;
const DATA_PREFIX = Buffer.from("data:");
const LF = 0x0a;
const CR = 0x0d;
const COLON = 0x3a;
const SHOW_HEADERS = new Set(["content-type", "content-length", "user-agent", "x-goog-api-client", "transfer-encoding"]);
const SHOW_STRINGS = new Set([
  "model", "modelVersion", "role", "finishReason", "mimeType", "requestType", "ideType", "platform",
  "pluginType", "status", "reason", "domain", "@type", "type", "alt",
]);
const FINGERPRINT_KEYS = /thoughtSignature|token|secret|email|project/iu;
const stdoutOutput: RecorderOutput = (line) => process.stdout.write(`${line}\n`);

const safeText = (value: string, maxChars: number): string =>
  renderCaptureToken(value.replace(/[\p{Cf}\u{2028}\u{2029}]/gu, ""), maxChars);

const safeValue = (value: string): string => JSON.stringify(safeText(value, MAX_VALUE_CHARS));

/** Replace lone surrogates so encodeURIComponent cannot throw (String#toWellFormed is ES2024, past the lib target). */
const wellFormed = (value: string): string => value.replace(/[\uD800-\uDFFF]/gu, "�");

/** Cap for an allow-listed header value; a User-Agent is longer than a JSON enum value. */
const MAX_HEADER_VALUE_CHARS = 256;

const requestTargetShape = (target: string): string => {
  const separator = target.indexOf("?");
  if (separator === -1) return target;
  const query: string[] = [];
  for (const [name, value] of new URLSearchParams(target.slice(separator + 1))) {
    const key = encodeURIComponent(wellFormed(safeText(name, MAX_VALUE_CHARS)));
    query.push(name === "alt" ? `${key}=${safeValue(value)}` : key);
  }
  return `${target.slice(0, separator)}?${query.join("&")}`;
};

const recordHeaders = (raw: readonly string[], kind: string, emit: RecorderOutput): void => {
  for (let i = 0; i + 1 < raw.length; i += 2) {
    const name = raw[i]!;
    const value = raw[i + 1]!;
    const shown = SHOW_HEADERS.has(name.toLowerCase())
      ? safeText(value, MAX_HEADER_VALUE_CHARS)
      : redactedValue(value);
    emit(`${kind} HEADER ${safeText(name, MAX_VALUE_CHARS)}: ${shown}`);
  }
};

type JsonParse = { readonly ok: true; readonly value: unknown } | { readonly ok: false };

const parseJson = (body: Buffer): JsonParse => {
  try {
    return { ok: true, value: JSON.parse(body.toString("utf8")) };
  } catch {
    return { ok: false };
  }
};

const fingerprint = (value: unknown): string => {
  try {
    return redactedValue(typeof value === "string" ? value : JSON.stringify(value));
  } catch {
    // A parsed object can exceed the native stringifier's stack limit.
    return "<fingerprint-unavailable>";
  }
};

const keyPath = (key: string): string => /^[a-zA-Z_$][a-zA-Z0-9_$]{0,63}$/u.test(key)
  ? `.${key}`
  : `[${safeValue(key)}]`;

interface ShapeField {
  readonly path: string;
  readonly depth: number;
  readonly revealValues: boolean;
  readonly tierContainer?: boolean;
  readonly showString?: boolean;
}

interface ShapeNode extends ShapeField {
  readonly value: unknown;
  readonly fingerprinted?: boolean;
}

const scalarShape = (value: unknown, field: ShapeField): string => {
  if (typeof value === "string") {
    const shown = field.revealValues && field.showString ? `,value=${safeValue(value)}` : "";
    return `string(len=${value.length}${shown})`;
  }
  if (typeof value === "boolean" || typeof value === "number") {
    return field.revealValues && (typeof value === "boolean" || Number.isFinite(value))
      ? `${typeof value}(${value})`
      : typeof value;
  }
  return "null";
};

const shapeLine = (node: ShapeNode): string => {
  const { value, path } = node;
  if (node.fingerprinted === true) return `${path}=${fingerprint(value)}`;
  if (Array.isArray(value)) return `${path}=array(len=${value.length})`;
  return isPlainObject(value) ? `${path}=object` : `${path}=${scalarShape(value, node)}`;
};

/** Return at most `room` child nodes, in array or key order. */
const childNodes = (node: ShapeNode, room: number): ShapeNode[] => {
  const { value, path, depth, revealValues, tierContainer = false } = node;
  const children: ShapeNode[] = [];
  if (node.fingerprinted === true || depth >= MAX_DEPTH) return children;
  if (Array.isArray(value)) {
    for (let i = 0; i < Math.min(value.length, MAX_ARRAY_ITEMS, room); i++) {
      const item: unknown = value[i];
      children.push({ value: item, path: `${path}[${i}]`, depth: depth + 1, revealValues, tierContainer: tierContainer && isPlainObject(item) });
    }
    return children;
  }
  if (!isPlainObject(value)) return children;
  for (const key in value) {
    if (!Object.hasOwn(value, key)) continue;
    if (children.length >= Math.min(MAX_OBJECT_KEYS, room)) break;
    const child = value[key];
    const childPath = path + keyPath(key);
    // A finite count such as usageMetadata.totalTokenCount or maxOutputTokens is not a secret.
    if (FINGERPRINT_KEYS.test(key) && !(typeof child === "number" && Number.isFinite(child))) {
      children.push({ value: child, path: childPath, depth: depth + 1, revealValues: false, fingerprinted: true });
      continue;
    }
    children.push({
      value: child,
      path: childPath,
      depth: depth + 1,
      revealValues: revealValues && key !== "args" && key !== "functionResponse",
      tierContainer: /Tiers?$/u.test(key),
      showString: SHOW_STRINGS.has(key) || (key === "id" && tierContainer),
    });
  }
  return children;
};

/**
 * Walk breadth first: every field at one depth prints before the next depth,
 * so a deep first field cannot use up MAX_FIELDS and hide a later sibling.
 * Each queued node prints one line, so the queue never holds more than MAX_FIELDS.
 */
const shapeOf = (value: unknown): string => {
  const queue: ShapeNode[] = [{ value, path: "$", depth: 0, revealValues: true }];
  const fields: string[] = [];
  for (let head = 0; head < queue.length; head++) {
    const node = queue[head]!;
    fields.push(shapeLine(node));
    queue.push(...childNodes(node, MAX_FIELDS - queue.length));
  }
  return fields.join(" ");
};

interface BodyCapture {
  readonly add: (chunk: Buffer) => void;
  readonly end: () => void;
}

const jsonCapture = (kind: string, emit: RecorderOutput): BodyCapture => {
  const capture = new BoundedCapture(MAX_CAPTURE_BYTES);
  let capped = false;
  return {
    add: (chunk) => {
      if (!capped && !capture.append(chunk)) {
        capped = true;
        capture.reset();
      }
    },
    end: () => {
      if (capped) {
        emit(`${kind} BODY kind=body-cap`);
      } else if (capture.bytes.length > 0) {
        const parsed = parseJson(capture.bytes);
        emit(`${kind} BODY ${parsed.ok ? shapeOf(parsed.value) : "kind=non-json"}`);
      }
    },
  };
};

/** Inspect one physical data line at a time. Keep wire bytes separate from the view. */
const sseCapture = (emit: RecorderOutput): BodyCapture => {
  const capture = new BoundedCapture(MAX_CAPTURE_BYTES);
  let size = 0;
  let events = 0;
  let detail = 0;
  const finishLine = (): void => {
    const bytes = capture.bytes;
    const isData = bytes.subarray(0, DATA_PREFIX.length).equals(DATA_PREFIX);
    const line = bytes.at(-1) === CR ? bytes.subarray(0, -1) : bytes;
    if (isData) events++;
    if (line.length !== 0 && detail < MAX_SSE_DETAIL_LINES) {
      detail++;
      if (size > MAX_CAPTURE_BYTES) {
        emit("SSE kind=line-cap");
      } else if (!isData) {
        emit(line[0] === COLON ? "SSE kind=comment" : "SSE kind=other");
      } else {
        const parsed = parseJson(line.subarray(DATA_PREFIX.length));
        emit(parsed.ok ? `SSE event=${events} bytes=${line.length} ${shapeOf(parsed.value)}` : "SSE kind=invalid-json");
      }
    }
    size = 0;
    capture.reset();
  };
  return {
    add: (chunk) => {
      for (let start = 0; start < chunk.length;) {
        const newline = chunk.indexOf(LF, start);
        const end = newline === -1 ? chunk.length : newline;
        const limit = detail < MAX_SSE_DETAIL_LINES ? MAX_CAPTURE_BYTES : DATA_PREFIX.length;
        const keep = Math.min(end - start, limit - size);
        if (keep > 0) capture.append(chunk.subarray(start, start + keep));
        size += end - start;
        if (newline !== -1) finishLine();
        start = end + 1;
      }
    },
    end: () => {
      if (size > 0) finishLine();
      emit(`SSE TOTAL events=${events}`);
    },
  };
};

const isGzip = (encoding: string | undefined): boolean => encoding?.trim().toLowerCase() === "gzip";

/**
 * Decode a gzip body for the view only. The relay still forwards the wire
 * bytes and the content-encoding header unchanged. A decode failure or the
 * decode cap prints a fixed kind, never the decoder message or the bytes.
 */
const gunzipView = (label: string, capture: BodyCapture, emit: RecorderOutput): BodyCapture => {
  const decoder = zlib.createGunzip();
  let written = false;
  let decoded = 0;
  let stopped = false;
  const stop = (kind: string): void => {
    if (stopped) return;
    stopped = true;
    emit(`${label} kind=${kind}`);
    decoder.destroy();
  };
  decoder.on("data", (chunk: Buffer) => {
    if (stopped) return;
    decoded += chunk.length;
    if (decoded > MAX_DECODED_BYTES) stop("decode-cap");
    else capture.add(chunk);
  });
  decoder.once("end", () => {
    if (!stopped) capture.end();
  });
  decoder.on("error", () => stop("invalid-gzip"));
  return {
    add: (chunk) => {
      if (stopped || chunk.length === 0) return;
      written = true;
      decoder.write(chunk);
    },
    end: () => {
      if (stopped) return;
      // An empty body is not a gzip stream; give the view the same empty end as an identity body.
      if (!written) capture.end();
      else decoder.end();
    },
  };
};

const bodyView = (encoding: string | undefined, label: string, capture: BodyCapture, emit: RecorderOutput): BodyCapture =>
  isGzip(encoding) ? gunzipView(label, capture, emit) : capture;

const observeBody = (source: http.IncomingMessage, capture: BodyCapture, count: (bytes: number) => void): void => {
  source.on("data", (chunk: Buffer) => {
    count(chunk.length);
    capture.add(chunk);
  });
  source.once("end", capture.end);
};

const relay = (req: http.IncomingMessage, res: http.ServerResponse, upstream: URL, emit: RecorderOutput): void => {
  const method = req.method ?? "GET";
  const path = req.url ?? "/";
  let requestBytes = 0;
  let responseBytes = 0;
  let status = 0;
  let outgoing: http.ClientRequest | undefined;
  let incoming: http.IncomingMessage | undefined;
  const total = (suffix: string): void => emit(`TOTAL status=${status} requestBytes=${requestBytes} responseBytes=${responseBytes}${suffix}`);
  const fail = (code: number, message: string): void => {
    if (res.destroyed || res.writableEnded) return;
    if (res.headersSent) {
      res.destroy();
    } else {
      status = code;
      responseBytes = Buffer.byteLength(message);
      emit(`RESPONSE status=${status} kind=synthetic`);
      res.writeHead(status, { "content-type": "text/plain", "content-length": responseBytes }).end(message);
    }
  };
  res.once("finish", () => total(""));
  res.once("close", () => {
    if (!res.writableFinished) total(" kind=aborted");
    if (!res.writableFinished || !req.complete) {
      outgoing?.destroy();
      incoming?.destroy();
    }
  });
  req.once("error", () => res.destroy());
  // Preserve the accepted target verbatim. The vetted origin selects the socket.
  if (!/^(?:\*|\/(?!\/)[\x21-\x7e]*)$/u.test(path) || /[\\#]/u.test(path)) {
    fail(400, "invalid request target");
    return;
  }
  emit(`REQUEST ${method} ${requestTargetShape(path)}`);
  recordHeaders(req.rawHeaders, "REQUEST", emit);
  const onReply = (reply: http.IncomingMessage): void => {
    incoming = reply;
    reply.once("error", () => fail(502, UPSTREAM_FAILURE));
    if (res.destroyed || res.writableEnded) {
      reply.destroy();
      return;
    }
    status = reply.statusCode ?? 502;
    emit(`RESPONSE status=${status}`);
    recordHeaders(reply.rawHeaders, "RESPONSE", emit);
    res.writeHead(status, reply.statusMessage, filterRawHeaders(reply.rawHeaders, HOP_BY_HOP));
    res.flushHeaders();
    const mime = reply.headers["content-type"]?.split(";", 1)[0]?.trim().toLowerCase();
    const sse = mime === "text/event-stream";
    const capture = bodyView(reply.headers["content-encoding"], sse ? "SSE" : "RESPONSE BODY",
      sse ? sseCapture(emit) : jsonCapture("RESPONSE", emit), emit);
    observeBody(reply, capture, (bytes) => { responseBytes += bytes; });
    reply.pipe(res);
  };
  const transport = upstream.protocol === "https:" ? https : http;
  try {
    outgoing = transport.request(upstream, { method, path, agent: false }, onReply);
    outgoing.once("error", () => fail(502, UPSTREAM_FAILURE));
    outgoing.setTimeout(UPSTREAM_IDLE_MS, () => outgoing?.destroy(new Error(UPSTREAM_FAILURE)));
    setRawRequestHeaders(outgoing, filterRawHeaders(req.rawHeaders, HOP_BY_HOP));
    if (!outgoing.hasHeader("content-length") && (req.headers["transfer-encoding"] || req.headers["content-length"])) {
      // Regenerate HTTP framing, including for methods Node does not chunk by default.
      outgoing.setHeader("transfer-encoding", "chunked");
    }
    observeBody(req, bodyView(req.headers["content-encoding"], "REQUEST BODY", jsonCapture("REQUEST", emit), emit),
      (bytes) => { requestBytes += bytes; });
    req.pipe(outgoing);
  } catch {
    outgoing?.destroy();
    fail(502, UPSTREAM_FAILURE);
  }
};

export interface RecorderOptions {
  readonly upstream?: string;
  readonly output?: RecorderOutput;
}

const parseLoopbackOrigin = (value: string): URL | undefined => {
  const url = URL.parse(value);
  if (url === null || (url.protocol !== "http:" && url.protocol !== "https:") || !isLoopbackHost(url.hostname)) return;
  if (url.href !== `${url.origin}/`) return;
  // Do not depend on the resolver to keep this alias on loopback.
  if (url.hostname === "localhost") url.hostname = LISTEN_HOST;
  return url;
};

/** Validate at construction, before the caller can bind a port. */
export const createGeminiRecorderServer = (options: RecorderOptions = {}): http.Server => {
  const upstream = options.upstream === undefined ? new URL(DEFAULT_UPSTREAM) : parseLoopbackOrigin(options.upstream);
  if (upstream === undefined) throw new Error(UPSTREAM_REFUSAL);
  const output = options.output ?? stdoutOutput;
  let seq = 0;
  return http.createServer((req, res) => {
    // Keep capture local even if a factory caller binds a different address.
    if (req.socket.localAddress !== LISTEN_HOST) {
      res.destroy();
      return;
    }
    const id = ++seq;
    relay(req, res, upstream, (line) => output(safeText(`#${id} ${line}`, MAX_LINE_CHARS - 1)));
  });
};

const start = (): void => {
  const portSetting = process.env["GEMINI_RECORDER_PORT"] ?? String(LISTEN_PORT);
  const port = Number(portSetting);
  if (!/^\d{4,5}$/u.test(portSetting) || port < 1024 || port > 65_535) {
    stdoutOutput("gemini-recorder: port must be an integer from 1024 to 65535");
    process.exitCode = 1;
    return;
  }
  const upstream = process.env["GEMINI_RECORDER_UPSTREAM"];
  let server: http.Server;
  try {
    server = createGeminiRecorderServer(upstream === undefined ? {} : { upstream });
  } catch {
    stdoutOutput(UPSTREAM_REFUSAL);
    process.exitCode = 1;
    return;
  }
  server.once("error", () => {
    stdoutOutput("gemini-recorder: cannot listen on loopback");
    process.exitCode = 1;
  });
  server.listen(port, LISTEN_HOST, () => stdoutOutput(`gemini-recorder: listen at http://${LISTEN_HOST}:${port}`));
};

if (process.argv[1] !== undefined && pathToFileURL(process.argv[1]).href === import.meta.url) start();
