/**
 * e2e/capture/codex-recorder.ts
 *
 * NOT-PRODUCTION: Dev-only wire-capture recorder.
 * Run via:  npx tsx e2e/capture/codex-recorder.ts
 * Excluded from tsconfig "include" and npm test globs — never bundled.
 *
 * ╔══════════════════════════════════════════════════════════════════════╗
 * ║  **NEVER COMMIT CAPTURED OUTPUT.**                                  ║
 * ║  **Derived fixtures MUST use fabricated values.**                   ║
 * ╚══════════════════════════════════════════════════════════════════════╝
 *
 * Listens on 127.0.0.1:4142, transparently forwards every request to the
 * real Codex backend, and records request/response wire shapes to stdout.
 * No file writing. Credential values are NEVER printed — only structural
 * fingerprints (<len:N,sha8:XXXXXXXX>). Message text is NEVER printed.
 *
 * Usage:
 *   npx tsx e2e/capture/codex-recorder.ts
 *
 * When routing real Codex CLI through the recorder (most common):
 *   CODEX_RECORDER_UPSTREAM=https://chatgpt.com \
 *   npx tsx e2e/capture/codex-recorder.ts
 *   # then: codex -c chatgpt_base_url="http://127.0.0.1:4142" exec "say hi"
 *
 * Override upstream for other base paths:
 *   CODEX_RECORDER_UPSTREAM=https://chatgpt.com/backend-api/codex \
 *   npx tsx e2e/capture/codex-recorder.ts
 *   # then: codex -c chatgpt_base_url="http://127.0.0.1:4142/backend-api/codex" exec "say hi"
 */

import * as http from "node:http";
import * as https from "node:https";
import * as crypto from "node:crypto";
import { pathToFileURL } from "node:url";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const LISTEN_PORT = 4142;
const LISTEN_HOST = "127.0.0.1";
const UPSTREAM_BASE =
  process.env["CODEX_RECORDER_UPSTREAM"] ?? "https://chatgpt.com/backend-api/codex";

/** Maximum number of fields serialised per body shape (across all depths). */
const MAX_SHAPE_FIELDS = 100;
/** Maximum nesting depth for body shape serialisation. */
const MAX_SHAPE_DEPTH = 6;
/** Maximum number of SSE event-type lines printed per response; beyond this only a counter runs. */
const MAX_SSE_EVENTS = 200;

// ---------------------------------------------------------------------------
// Structural redaction (ADR-002: never print credential values)
// ---------------------------------------------------------------------------

/** Header names whose values are always redacted. */
const REDACT_EXACT = new Set([
  "authorization",
  "chatgpt-account-id",
  "cookie",
  "set-cookie",
]);

/** Patterns applied to lowercased header names; a match → redact. */
const REDACT_PATTERNS: readonly RegExp[] = [
  /^openai-sentinel-/,
  /token/,
  /secret/,
];

function shouldRedactHeader(name: string): boolean {
  const lower = name.toLowerCase();
  if (REDACT_EXACT.has(lower)) return true;
  return REDACT_PATTERNS.some((p) => p.test(lower));
}

function sha8(value: string): string {
  return crypto.createHash("sha256").update(value, "utf8").digest("hex").slice(0, 8);
}

/** Redact a sensitive value: emit length + sha256 prefix for cross-request stability. */
function redactedValue(value: string): string {
  return `<len:${value.length},sha8:${sha8(value)}>`;
}

/** True for JWT-looking strings: base64url-encoded JSON header, two dots. */
function isJwtLooking(value: string): boolean {
  return value.startsWith("eyJ") && (value.match(/\./g) ?? []).length >= 2;
}

// ---------------------------------------------------------------------------
// Body shape: field names + types, all string values replaced by <len:N>
// ---------------------------------------------------------------------------

type FieldCounter = { n: number };

/**
 * Recursively produce a JSON-serialisable "shape skeleton" of an arbitrary
 * value: object keys are preserved, arrays are shown as { _array: N, _item:
 * <first-element-shape> }, strings become "<len:N>" (or JWT fingerprint),
 * numbers and booleans are kept (non-sensitive), nulls are kept.
 */
function shapeOf(value: unknown, depth: number, counter: FieldCounter): unknown {
  if (counter.n >= MAX_SHAPE_FIELDS) return "<cap:fields>";
  if (depth >= MAX_SHAPE_DEPTH) return "<cap:depth>";

  if (value === null || value === undefined) return null;

  if (typeof value === "boolean") return `<bool:${String(value)}>`;

  // Numbers are non-sensitive (token counts, indices, etc.)
  if (typeof value === "number") return value;

  if (typeof value === "string") {
    if (isJwtLooking(value)) return `<jwt,len:${value.length},sha8:${sha8(value)}>`;
    return `<len:${value.length}>`;
  }

  if (Array.isArray(value)) {
    counter.n++;
    const len = value.length;
    if (len === 0) return { _array: 0 };
    // Only sample the first element to avoid exponential expansion.
    const item = shapeOf(value[0], depth + 1, counter);
    return { _array: len, _item: item };
  }

  if (typeof value === "object") {
    const result: Record<string, unknown> = {};
    const entries = Object.entries(value as Record<string, unknown>);
    for (const [k, v] of entries) {
      if (counter.n >= MAX_SHAPE_FIELDS) {
        result["<...>"] = `<cap: ${entries.length - Object.keys(result).length} more fields>`;
        break;
      }
      counter.n++;
      result[k] = shapeOf(v, depth + 1, counter);
    }
    return result;
  }

  return "<unknown>";
}

/** Outcome of decoding a buffered body as JSON. */
type JsonParse =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false };

const NOT_JSON: JsonParse = { ok: false };

/**
 * Decode a buffered body as JSON exactly once. Codex request bodies carry whole
 * conversation histories, so the decode + parse sits on the time-to-first-byte
 * path: every consumer (the printed shape, the streamed-Responses eligibility
 * rule) reads this single result rather than re-parsing the buffer.
 */
function parseJsonBody(body: Buffer): JsonParse {
  if (body.byteLength === 0) return NOT_JSON;
  try {
    return { ok: true, value: JSON.parse(body.toString("utf8")) as unknown };
  } catch {
    return NOT_JSON;
  }
}

/**
 * True when the request body declared `"stream": true` — the request-side
 * clause of the headerless-SSE eligibility rule (PF-013).
 */
function declaresStream(parse: JsonParse): boolean {
  if (!parse.ok) return false;
  const { value } = parse;
  return typeof value === "object" && value !== null && (value as Record<string, unknown>)["stream"] === true;
}

/**
 * Return a pretty-printed shape skeleton for an already-parsed body buffer.
 * Falls back to a byte count when the body is not JSON.
 */
function bodyShape(body: Buffer, contentType: string | undefined, parse: JsonParse): string {
  if (body.byteLength === 0) return "<empty>";

  const looksJson =
    (contentType ?? "").includes("json") ||
    (contentType === undefined &&
      (() => {
        const peek = body.slice(0, 8).toString("utf8").trimStart();
        return peek.startsWith("{") || peek.startsWith("[");
      })());

  if (!looksJson) return `<binary: ${body.byteLength} bytes>`;
  if (!parse.ok) return `<invalid-json: ${body.byteLength} bytes>`;

  const counter: FieldCounter = { n: 0 };
  const shape = shapeOf(parse.value, 0, counter);
  return JSON.stringify(shape, null, 2);
}

// ---------------------------------------------------------------------------
// Header utilities
// ---------------------------------------------------------------------------

/** Hop-by-hop headers that must not be forwarded (RFC 7230 §6.1). */
const HOP_BY_HOP = new Set([
  "host",
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

/**
 * Build a flat [name, value, …] header list suitable for display, with
 * sensitive values replaced by structural fingerprints.
 */
function formatRawHeaders(rawHeaders: readonly string[]): string[] {
  const lines: string[] = [];
  for (let i = 0; i + 1 < rawHeaders.length; i += 2) {
    const name = rawHeaders[i] as string;
    const value = rawHeaders[i + 1] as string;
    const display = shouldRedactHeader(name) ? redactedValue(value) : value;
    lines.push(`  ${name}: ${display}`);
  }
  return lines;
}

/**
 * Build a header object for the outbound upstream request, stripping
 * hop-by-hop headers but preserving all others verbatim (including casing).
 * content-length is set explicitly from the buffered body.
 */
function buildForwardHeaders(
  rawHeaders: readonly string[],
  bodyLength: number,
): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  for (let i = 0; i + 1 < rawHeaders.length; i += 2) {
    const name = rawHeaders[i] as string;
    const value = rawHeaders[i + 1] as string;
    const lower = name.toLowerCase();
    if (HOP_BY_HOP.has(lower) || lower === "content-length") continue;
    const existing = out[lower];
    if (existing === undefined) {
      out[lower] = value;
    } else if (Array.isArray(existing)) {
      existing.push(value);
    } else {
      out[lower] = [existing, value];
    }
  }
  // Set exact content-length because we buffered the full body.
  out["content-length"] = String(bodyLength);
  return out;
}

// ---------------------------------------------------------------------------
// Printing
// ---------------------------------------------------------------------------

let requestSeq = 0;

export type RecorderOutput = (line: string) => void;

const stdoutOutput: RecorderOutput = (line) => process.stdout.write(line + "\n");

/** Column width of the horizontal rules drawn around each transcript block. */
const SEPARATOR_WIDTH = 64;

/** The line-oriented printing surface bound to one recorder's output sink. */
interface Printer {
  /** Emit one transcript line. */
  readonly println: RecorderOutput;
  /** Emit a labelled block header framed by two horizontal rules. */
  readonly separator: (label: string) => void;
  /** Emit a multi-line value, prefixing every line. */
  readonly indent: (value: string, prefix?: string) => void;
}

/**
 * Build the printing surface once per recorder. The rule string is computed a
 * single time rather than per request, and `output` is the only sink: nothing
 * here writes to stdout directly.
 */
const createPrinter = (output: RecorderOutput): Printer => {
  const rule = "─".repeat(SEPARATOR_WIDTH);
  return {
    println: output,
    separator: (label) => {
      output(`\n${rule}`);
      output(`  ${label}`);
      output(rule);
    },
    indent: (value, prefix = "  ") => {
      for (const line of value.split("\n")) output(`${prefix}${line}`);
    },
  };
};

// ---------------------------------------------------------------------------
// SSE event parser
// ---------------------------------------------------------------------------

interface SseEventRecord {
  /** The `type` field from the JSON data payload (primary event kind). */
  type: string;
  /** Parsed JSON data payload (if any). */
  data: unknown;
}

/**
 * Parse a raw SSE event block (everything between two blank-line delimiters)
 * into a structured record. Returns undefined for comments, [DONE], and
 * unparseable data.
 */
function parseSseBlock(block: string): SseEventRecord | undefined {
  const dataLines: string[] = [];
  for (const line of block.split(/\r?\n/)) {
    if (line.startsWith("data:")) {
      dataLines.push(line.slice(5).replace(/^ /, ""));
    }
  }
  if (dataLines.length === 0) return undefined;
  const raw = dataLines.join("\n");
  if (raw === "[DONE]") return undefined;
  let json: unknown;
  try {
    json = JSON.parse(raw) as unknown;
  } catch {
    return undefined;
  }
  if (typeof json !== "object" || json === null) return undefined;
  const type = (json as Record<string, unknown>)["type"];
  if (typeof type !== "string") return undefined;
  return { type, data: json };
}

/**
 * Extract the `usage` sub-object from a `response.completed` payload.
 * Token counts are not sensitive; print them verbatim.
 */
function extractUsage(data: unknown): Record<string, unknown> | undefined {
  if (typeof data !== "object" || data === null) return undefined;
  const response = (data as Record<string, unknown>)["response"];
  if (typeof response !== "object" || response === null) return undefined;
  const usage = (response as Record<string, unknown>)["usage"];
  if (typeof usage !== "object" || usage === null) return undefined;
  return usage as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Response arms
// ---------------------------------------------------------------------------

/** Settlement handles for the promise tracking one upstream exchange. */
interface Settle {
  readonly resolve: () => void;
  readonly reject: (err: Error) => void;
}

/**
 * Capture arm: forward every upstream byte to the client untouched while
 * parsing a copy of the stream into event-type lines and terminal usage.
 */
function recordSseStream(
  upstreamRes: http.IncomingMessage,
  res: http.ServerResponse,
  printer: Printer,
  settle: Settle,
): void {
  const println = printer.println;
  println("SSE EVENTS:");
  let sseEventCount = 0;
  let lineBuf = "";
  let terminalUsagePrinted = false;

  const recordEvent = (event: SseEventRecord): void => {
    const usage = event.type === "response.completed" ? extractUsage(event.data) : undefined;
    if (sseEventCount < MAX_SSE_EVENTS) {
      println(`  [${sseEventCount + 1}] type=${event.type}${usage !== undefined ? `  usage=${JSON.stringify(usage)}` : ""}`);
    } else if (sseEventCount === MAX_SSE_EVENTS) {
      println(`  ... (cap: first ${MAX_SSE_EVENTS} events printed; counting only)`);
    }
    // Usage is terminal accounting rather than event detail. Keep it even
    // after the event-detail cap and when completion arrives at EOF.
    if (usage !== undefined && !terminalUsagePrinted) {
      println(`  TERMINAL USAGE: ${JSON.stringify(usage)}`);
      terminalUsagePrinted = true;
    }
    sseEventCount++;
  };

  upstreamRes.on("data", (chunk: Buffer) => {
    // Forward to client immediately (no buffering of response body)
    res.write(chunk);

    // Accumulate for SSE parsing
    lineBuf += chunk.toString("utf8");

    // Split on double-newline (SSE event boundary)
    const blocks = lineBuf.split(/\r?\n\r?\n/);
    // Last element is a partial block (keep in buffer)
    lineBuf = blocks.pop() ?? "";

    for (const block of blocks) {
      if (block.trim() === "") continue;
      const event = parseSseBlock(block);
      if (event === undefined) continue;

      recordEvent(event);
    }
  });

  upstreamRes.on("end", () => {
    // Flush any remaining partial block
    if (lineBuf.trim() !== "") {
      const event = parseSseBlock(lineBuf);
      if (event !== undefined) {
        recordEvent(event);
      }
    }
    println(`\n  SSE TOTAL: ${sseEventCount} events`);
    res.end();
    settle.resolve();
  });

  upstreamRes.on("error", (err) => {
    println(`  SSE UPSTREAM ERROR: ${(err as Error).message}`);
    settle.reject(err);
  });
}

/** Pass-through arm: relay the body verbatim, with no inspection. */
function pipeThrough(
  upstreamRes: http.IncomingMessage,
  res: http.ServerResponse,
  settle: Settle,
): void {
  upstreamRes.pipe(res);
  upstreamRes.on("end", settle.resolve);
  upstreamRes.on("error", settle.reject);
}

// ---------------------------------------------------------------------------
// Request handler
// ---------------------------------------------------------------------------

/** Media type the Responses endpoint declares when it declares one at all. */
const SSE_CONTENT_TYPE = "text/event-stream";
/** Path suffix identifying the Responses endpoint under any upstream base path. */
const RESPONSES_PATH_SUFFIX = "/responses";
/** Origin used solely to resolve a raw request target into a pathname; never dialled. */
const PATH_PARSE_BASE = "http://recorder.invalid";

/** True for any 2xx upstream status. */
const isSuccessStatus = (status: number | undefined): boolean =>
  status !== undefined && status >= 200 && status < 300;

/**
 * True when the raw request target resolves to a Responses endpoint path.
 *
 * A malformed target (`//`, `http://[`) makes the exchange ineligible rather
 * than fatal: this runs inside the upstream response callback, which is outside
 * the promise `handleRequest` awaits, so a throw here would escape the
 * `.catch()` on the handler and kill the recorder via `uncaughtException`.
 */
const isResponsesPath = (path: string): boolean => {
  try {
    return new URL(path, PATH_PARSE_BASE).pathname.endsWith(RESPONSES_PATH_SUFFIX);
  } catch {
    return false;
  }
};

/**
 * The facts the response-arm dispatch weighs, named rather than positional so
 * no caller can transpose the two adjacent strings.
 */
interface StreamProbe {
  /** Request method, as received. */
  readonly method: string;
  /** Raw request target, as received — not yet known to be a well-formed URL. */
  readonly path: string;
  /** The request body declared `"stream": true` (decided once, before forwarding). */
  readonly requestIsStreamedResponses: boolean;
  /** Upstream `Content-Type`, trimmed; `""` when the header is absent. */
  readonly contentType: string;
  /** Upstream status, or undefined when it could not be read. */
  readonly status: number | undefined;
}

/**
 * PF-013: the live Responses endpoint streams SSE with no Content-Type at all.
 * Eligibility keeps all four clauses — POST, a `/responses` path, a 2xx status,
 * and a request that asked for a stream — so ordinary proxy behaviour is
 * preserved everywhere else. Clauses run cheapest-first; the target is parsed
 * only once everything else already matches.
 */
const isExpectedMissingHeaderStream = (probe: StreamProbe): boolean =>
  probe.method === "POST" &&
  probe.requestIsStreamedResponses &&
  isSuccessStatus(probe.status) &&
  isResponsesPath(probe.path);

/** Choose the capture arm: an explicit SSE content type, or the PF-013 headerless case. */
const isSseResponse = (probe: StreamProbe): boolean =>
  probe.contentType.toLowerCase().includes(SSE_CONTENT_TYPE) ||
  (probe.contentType === "" && isExpectedMissingHeaderStream(probe));

/** Per-server state threaded into every request the recorder serves. */
interface RecorderContext {
  readonly upstreamBase: string;
  readonly printer: Printer;
}

async function handleRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  context: RecorderContext,
): Promise<void> {
  const { upstreamBase, printer } = context;
  const { println, separator, indent } = printer;
  const seq = ++requestSeq;
  const method = req.method ?? "GET";
  const path = req.url ?? "/";
  const ts = new Date().toISOString();

  separator(`REQUEST #${seq}  [${ts}]  ${method} ${path}`);

  // Collect request headers
  println("REQUEST HEADERS:");
  for (const line of formatRawHeaders(req.rawHeaders)) println(line);

  // Buffer request body (required for content-length forwarding)
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(chunk as Buffer);
  }
  const rawBody = Buffer.concat(chunks);
  const bodyParse = parseJsonBody(rawBody);
  const requestIsStreamedResponses = declaresStream(bodyParse);

  println("\nREQUEST BODY SHAPE:");
  indent(bodyShape(rawBody, req.headers["content-type"], bodyParse));

  // Resolve upstream URL: append the incoming path onto the configured base path.
  // e.g. UPSTREAM_BASE=https://chatgpt.com/backend-api/codex + path=/responses
  //   → hostname=chatgpt.com, upstreamPath=/backend-api/codex/responses
  const upstreamTarget = new URL(upstreamBase.replace(/\/$/, ""));
  const upstreamPath = upstreamTarget.pathname.replace(/\/$/, "") + path;

  const isHttps = upstreamTarget.protocol === "https:";
  const transport = isHttps ? https : http;
  const port = upstreamTarget.port
    ? Number(upstreamTarget.port)
    : isHttps
    ? 443
    : 80;

  const upstreamOptions: https.RequestOptions = {
    hostname: upstreamTarget.hostname,
    port,
    path: upstreamPath,
    method,
    headers: buildForwardHeaders(req.rawHeaders, rawBody.byteLength),
  };

  await new Promise<void>((resolve, reject) => {
    const settle: Settle = { resolve: () => resolve(), reject };
    const upstreamReq = transport.request(upstreamOptions, (upstreamRes) => {
      separator(`RESPONSE #${seq}  status=${upstreamRes.statusCode ?? "?"}`);

      println("RESPONSE HEADERS:");
      for (const line of formatRawHeaders(upstreamRes.rawHeaders)) println(line);
      println("");

      // Forward status + filtered response headers to client
      const fwdHeaders = buildForwardHeaders(upstreamRes.rawHeaders, 0);
      // remove our placeholder content-length (upstream sets it or it's chunked)
      delete fwdHeaders["content-length"];
      res.writeHead(upstreamRes.statusCode ?? 502, fwdHeaders);

      const probe: StreamProbe = {
        method,
        path,
        requestIsStreamedResponses,
        contentType: (upstreamRes.headers["content-type"] ?? "").trim(),
        status: upstreamRes.statusCode,
      };

      if (isSseResponse(probe)) {
        recordSseStream(upstreamRes, res, printer, settle);
      } else {
        pipeThrough(upstreamRes, res, settle);
      }
    });

    upstreamReq.on("error", (err) => {
      const msg = (err as Error).message;
      println(`UPSTREAM CONNECTION ERROR: ${msg}`);
      if (!res.headersSent) {
        res.writeHead(502);
        res.end("upstream connection error");
      }
      reject(err);
    });

    upstreamReq.write(rawBody);
    upstreamReq.end();
  });
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

/**
 * Create a dev-only recorder without binding a port. Tests and local probes can
 * listen on an ephemeral loopback port; importing this module has no side effect.
 */
export const createCodexRecorderServer = (
  upstreamUrl: string,
  output: RecorderOutput = stdoutOutput,
): http.Server => {
  const context: RecorderContext = { upstreamBase: upstreamUrl, printer: createPrinter(output) };
  return http.createServer((req, res) => {
    handleRequest(req, res, context).catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      output(`HANDLER ERROR: ${msg}`);
      if (!res.headersSent) {
        res.writeHead(500);
        res.end("recorder error");
      }
    });
  });
};

const isDirectExecution = process.argv[1] !== undefined && pathToFileURL(process.argv[1]).href === import.meta.url;
if (isDirectExecution) {
  // CLI-only last resort. A capture session is long and unattended, so a stray
  // throw from an event callback must cost one transcript line, not the whole
  // recording. Scoped here deliberately: the factory stays import-safe and
  // never mutates process-global state for library consumers.
  process.on("uncaughtException", (err: unknown) => {
    stdoutOutput(`UNCAUGHT (recorder still listening): ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
  });

  const server = createCodexRecorderServer(UPSTREAM_BASE);
  server.listen(LISTEN_PORT, LISTEN_HOST, () => {
    stdoutOutput("╔══════════════════════════════════════════════════════════════╗");
    stdoutOutput("║         subswitch Codex wire-capture recorder (dev only)        ║");
    stdoutOutput("╚══════════════════════════════════════════════════════════════╝");
    stdoutOutput(`  Listening : http://${LISTEN_HOST}:${LISTEN_PORT}`);
    stdoutOutput(`  Upstream  : ${UPSTREAM_BASE}`);
    stdoutOutput("");
    stdoutOutput("  To route subswitch through this recorder, set codex.baseUrl in");
    stdoutOutput(`  subswitch.config.json to "http://${LISTEN_HOST}:${LISTEN_PORT}"`);
    stdoutOutput("");
    stdoutOutput("  Override upstream: CODEX_RECORDER_UPSTREAM=https://... npx tsx ...");
    stdoutOutput("");
  });
  process.on("SIGINT", () => {
    stdoutOutput("\nShutting down recorder.");
    server.close();
    process.exit(0);
  });
}
