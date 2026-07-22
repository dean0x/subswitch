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

/**
 * Return a pretty-printed shape skeleton for a request/response body buffer.
 * Falls back to a byte count when the body cannot be parsed as JSON.
 */
function bodyShape(body: Buffer, contentType: string | undefined): string {
  if (body.byteLength === 0) return "<empty>";

  const looksJson =
    (contentType ?? "").includes("json") ||
    (contentType === undefined &&
      (() => {
        const peek = body.slice(0, 8).toString("utf8").trimStart();
        return peek.startsWith("{") || peek.startsWith("[");
      })());

  if (!looksJson) return `<binary: ${body.byteLength} bytes>`;

  let parsed: unknown;
  try {
    parsed = JSON.parse(body.toString("utf8")) as unknown;
  } catch {
    return `<invalid-json: ${body.byteLength} bytes>`;
  }

  const counter: FieldCounter = { n: 0 };
  const shape = shapeOf(parsed, 0, counter);
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

function println(line: string): void {
  process.stdout.write(line + "\n");
}

function separator(label: string): void {
  println(`\n${"─".repeat(64)}`);
  println(`  ${label}`);
  println("─".repeat(64));
}

function indent(text: string, prefix = "  "): void {
  for (const line of text.split("\n")) println(`${prefix}${line}`);
}

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
// Request handler
// ---------------------------------------------------------------------------

async function handleRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
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

  println("\nREQUEST BODY SHAPE:");
  indent(bodyShape(rawBody, req.headers["content-type"]));

  // Resolve upstream URL: append the incoming path onto the configured base path.
  // e.g. UPSTREAM_BASE=https://chatgpt.com/backend-api/codex + path=/responses
  //   → hostname=chatgpt.com, upstreamPath=/backend-api/codex/responses
  const upstreamTarget = new URL(UPSTREAM_BASE.replace(/\/$/, ""));
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

      const contentType = (upstreamRes.headers["content-type"] ?? "") as string;
      const isSse = contentType.includes("text/event-stream");

      if (isSse) {
        println("SSE EVENTS:");
        let sseEventCount = 0;
        let lineBuf = "";

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

            if (sseEventCount < MAX_SSE_EVENTS) {
              let suffix = "";
              if (event.type === "response.completed") {
                const usage = extractUsage(event.data);
                if (usage !== undefined) {
                  suffix = `  usage=${JSON.stringify(usage)}`;
                }
              }
              println(`  [${sseEventCount + 1}] type=${event.type}${suffix}`);
            } else if (sseEventCount === MAX_SSE_EVENTS) {
              println(`  ... (cap: first ${MAX_SSE_EVENTS} events printed; counting only)`);
            }
            sseEventCount++;
          }
        });

        upstreamRes.on("end", () => {
          // Flush any remaining partial block
          if (lineBuf.trim() !== "") {
            const event = parseSseBlock(lineBuf);
            if (event !== undefined) {
              if (sseEventCount < MAX_SSE_EVENTS) {
                println(`  [${sseEventCount + 1}] type=${event.type}`);
              }
              sseEventCount++;
            }
          }
          println(`\n  SSE TOTAL: ${sseEventCount} events`);
          res.end();
          resolve();
        });

        upstreamRes.on("error", (err) => {
          println(`  SSE UPSTREAM ERROR: ${(err as Error).message}`);
          reject(err);
        });
      } else {
        // Non-SSE: pipe directly, no body inspection
        upstreamRes.pipe(res);
        upstreamRes.on("end", resolve);
        upstreamRes.on("error", reject);
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

const server = http.createServer((req, res) => {
  handleRequest(req, res).catch((err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err);
    println(`HANDLER ERROR: ${msg}`);
    if (!res.headersSent) {
      res.writeHead(500);
      res.end("recorder error");
    }
  });
});

server.listen(LISTEN_PORT, LISTEN_HOST, () => {
  println("╔══════════════════════════════════════════════════════════════╗");
  println("║         croxy Codex wire-capture recorder (dev only)        ║");
  println("╚══════════════════════════════════════════════════════════════╝");
  println(`  Listening : http://${LISTEN_HOST}:${LISTEN_PORT}`);
  println(`  Upstream  : ${UPSTREAM_BASE}`);
  println("");
  println("  To route croxy through this recorder, set codex.baseUrl in");
  println(`  croxy.config.json to "http://${LISTEN_HOST}:${LISTEN_PORT}"`);
  println("");
  println("  Override upstream: CODEX_RECORDER_UPSTREAM=https://... npx tsx ...");
  println("");
});

process.on("SIGINT", () => {
  println("\nShutting down recorder.");
  server.close();
  process.exit(0);
});
