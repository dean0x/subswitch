import http from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { loadConfig } from "../../src/config.js";
import { buildDeps, createProxyServer } from "../../src/server.js";

export interface RecordedRequest {
  readonly method: string;
  readonly url: string;
  readonly headers: http.IncomingHttpHeaders;
  readonly rawHeaders: string[]; // flat [name, value, ...] — original casing and order
  readonly body: Buffer;
}

export type UpstreamHandler = (req: IncomingMessage, res: ServerResponse, body: Buffer, requestIndex: number) => void;

export interface FakeUpstream {
  readonly url: string;
  readonly requests: RecordedRequest[];
  readonly connectionCount: number; // TCP connections made to this server
  close(): Promise<void>;
}

export const startFakeUpstream = async (handler: UpstreamHandler): Promise<FakeUpstream> => {
  const requests: RecordedRequest[] = [];
  let connectionCount = 0;
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const body = Buffer.concat(chunks);
      const index = requests.length;
      requests.push({
        method: req.method ?? "",
        url: req.url ?? "",
        headers: req.headers,
        rawHeaders: [...req.rawHeaders],
        body,
      });
      handler(req, res, body, index);
    });
  });
  server.on("connection", () => {
    connectionCount++;
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    get connectionCount() {
      return connectionCount;
    },
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
};

export const sseHandler = (sseText: string): UpstreamHandler => (_req, res) => {
  res.writeHead(200, { "content-type": "text/event-stream" });
  res.end(sseText);
};

export interface SubswitchInstance {
  readonly url: string;
  close(): Promise<void>;
}

export const startSubswitch = async (overrides: Record<string, unknown>): Promise<SubswitchInstance> => {
  const configResult = loadConfig({
    configPath: "inline-test-config.json",
    readFile: () => JSON.stringify({ logLevel: "error", ...overrides }),
  });
  if (!configResult.ok) throw new Error(configResult.error.message);
  const server = createProxyServer(buildDeps(configResult.value.config));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
};

// ---------------------------------------------------------------------------
// Auth fixtures shared by the codex-leg and auth-refresh suites.
// ---------------------------------------------------------------------------

export const makeJwt = (payload: Record<string, unknown>): string => {
  const encode = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "none", typ: "JWT" })}.${encode(payload)}.signature`;
};

export const makeAccessToken = (expiresAtMs: number, accountId = "acct_integration_1"): string =>
  makeJwt({ exp: expiresAtMs / 1000, "https://api.openai.com/auth": { chatgpt_account_id: accountId } });

export const makeAuthFileContent = (accessToken: string, refreshToken = "refresh-int-1"): string =>
  JSON.stringify(
    {
      OPENAI_API_KEY: null,
      tokens: { id_token: "id.int.x", access_token: accessToken, refresh_token: refreshToken, account_id: "acct_integration_1" },
      last_refresh: "2026-07-20T00:00:00.000Z",
      auth_mode: "chatgpt",
      future_cli_key: { must: "survive" },
    },
    null,
    2,
  );

// ---------------------------------------------------------------------------
// Raw HTTP request helper — bypasses fetch header normalization so tests can
// send and receive mixed-case / duplicate headers byte-for-byte.
// ---------------------------------------------------------------------------

export interface RawResponse {
  readonly status: number;
  /** Flat [name, value, name, value, ...] from the wire — original casing and order. */
  readonly rawHeaders: string[];
  readonly body: Buffer;
}

/**
 * Make an HTTP/1.1 request using Node's `http` module directly, preserving
 * header name casing.
 *
 * `rawHeaders` is a flat [name, value, ...] array. Each unique name (compared
 * case-insensitively) is set via `req.setHeader`, which preserves the original
 * casing when serialized. Duplicate names are sent as multi-value arrays so
 * they appear as separate header lines on the wire.
 *
 * Note: `http.request({ headers: flatArray })` uses `Object.keys` internally
 * (producing numeric indices), so we do NOT pass the flat array to `options.headers`.
 * We use `setHeader` calls instead.
 */
export const rawHttpRequest = (
  url: string,
  options: {
    readonly method: string;
    /** Flat [name, value, name, value, ...] — forwarded with casing preserved. */
    readonly rawHeaders: string[];
    readonly body?: Buffer;
  },
): Promise<RawResponse> => {
  const target = new URL(url);
  return new Promise<RawResponse>((resolve, reject) => {
    const req = http.request(
      {
        hostname: target.hostname,
        port: target.port !== "" ? Number(target.port) : 80,
        path: `${target.pathname}${target.search}`,
        method: options.method,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () =>
          resolve({ status: res.statusCode ?? 0, rawHeaders: [...res.rawHeaders], body: Buffer.concat(chunks) }),
        );
        res.on("error", reject);
      },
    );

    // Collect headers preserving insertion order and handling duplicates.
    // The first occurrence's name casing wins; duplicates are sent as arrays.
    // Map preserves insertion order, so no separate order-tracking array is needed.
    const seen = new Map<string, { name: string; values: string[] }>();
    for (let i = 0; i + 1 < options.rawHeaders.length; i += 2) {
      const name = options.rawHeaders[i]!;
      const value = options.rawHeaders[i + 1]!;
      const key = name.toLowerCase();
      const entry = seen.get(key);
      if (entry === undefined) {
        seen.set(key, { name, values: [value] });
      } else {
        entry.values.push(value);
      }
    }
    for (const { name, values } of seen.values()) {
      req.setHeader(name, values.length === 1 ? values[0]! : values);
    }

    req.on("error", reject);
    if (options.body !== undefined) {
      req.end(options.body);
    } else {
      req.end();
    }
  });
};
