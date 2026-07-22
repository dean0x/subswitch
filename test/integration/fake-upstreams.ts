import http from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { loadConfig } from "../../src/config.js";
import { buildDeps, createProxyServer } from "../../src/server.js";

export interface RecordedRequest {
  readonly method: string;
  readonly url: string;
  readonly headers: http.IncomingHttpHeaders;
  readonly body: Buffer;
}

export type UpstreamHandler = (req: IncomingMessage, res: ServerResponse, body: Buffer, requestIndex: number) => void;

export interface FakeUpstream {
  readonly url: string;
  readonly requests: RecordedRequest[];
  close(): Promise<void>;
}

export const startFakeUpstream = async (handler: UpstreamHandler): Promise<FakeUpstream> => {
  const requests: RecordedRequest[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const body = Buffer.concat(chunks);
      const index = requests.length;
      requests.push({ method: req.method ?? "", url: req.url ?? "", headers: req.headers, body });
      handler(req, res, body, index);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
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

export interface CroxyInstance {
  readonly url: string;
  close(): Promise<void>;
}

export const startCroxy = async (overrides: Record<string, unknown>): Promise<CroxyInstance> => {
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
