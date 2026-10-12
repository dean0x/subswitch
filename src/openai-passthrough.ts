import { boundTcpConnect } from "./tcp-connect.js";
import { observeNodeResponse } from "./limit-http-observer.js";
import { LimitWebSocketObserver } from "./limit-websocket-observer.js";
import { WebSocketBudget } from "./websocket-budget.js";
import { openaiErrorBody } from "./errors.js";
import http from "node:http";
import https from "node:https";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import type { CodexIngressConfig } from "./config.js";
import type { Logger } from "./logger.js";
import { SYNTHESIZED_HEADER, SYNTHESIZED_MARKER } from "./errors.js";
import { type CodexEndpointMode } from "./codex-ingress.js";
import {
  createRawHttpForwarder,
  filterRawHeaders,
  setRawRequestHeaders,
  HOP_BY_HOP,
  RESPONSE_STRIP,
  type ForwardedBody,
  type ForwardHooks,
} from "./raw-http-passthrough.js";

/** HTTP error response for sockets handed off by Node's upgrade event. */
export const rejectCodexUpgrade = (req: IncomingMessage, socket: Duplex, status: number, message: string,
  errorBody: (message: string) => string = openaiErrorBody): void => {
  if (socket.destroyed) return;
  const response = new http.ServerResponse(req);
  response.assignSocket(req.socket);
  // Manually attached responses do not have http.Server's usual finish handler.
  response.once("finish", () => socket.end());
  socket.resume();
  response.writeHead(status, {
    "content-type": "application/json",
    connection: "close",
    [SYNTHESIZED_HEADER]: SYNTHESIZED_MARKER,
  });
  response.end(errorBody(message));
};

export interface CodexIngressEntry {
  http(req: IncomingMessage, res: ServerResponse, mode: CodexEndpointMode, path: string): void;
  upgrade(req: IncomingMessage, socket: Duplex, head: Buffer, mode: CodexEndpointMode, path: string): void;
  close(): void;
}

export interface OpenaiPassthrough extends CodexIngressEntry {
  http(
    req: IncomingMessage,
    res: ServerResponse,
    mode: CodexEndpointMode,
    path: string,
    body?: ForwardedBody,
    rawHeaders?: readonly string[],
    hooks?: ForwardHooks,
  ): void;
  upgrade(
    req: IncomingMessage,
    socket: Duplex,
    head: Buffer,
    mode: CodexEndpointMode,
    path: string,
    rawHeaders?: readonly string[],
  ): void;
  close(): void;
}

/** Raw transport uses caller-supplied headers/body; native credential policy belongs to the ingress. */
export function createOpenaiPassthrough(
  config: CodexIngressConfig,
  logger: Logger,
  budget = new WebSocketBudget(config.maxUpstreamSockets),
): OpenaiPassthrough {
  const targets = {
    subscription: new URL(config.subscriptionBaseUrl),
    api: new URL(config.apiBaseUrl),
  };
  const options = {
    connectTimeoutMs: config.connectTimeoutMs,
    maxUpstreamSockets: config.maxUpstreamSockets,
    logger,
    errorBody: openaiErrorBody,
    logPath: () => "/codex",
    events: { timeout: "openai_upstream_timeout", error: "openai_upstream_error" } as const,
  };
  const forwarders = {
    subscription: createRawHttpForwarder({ ...options, baseUrl: config.subscriptionBaseUrl,
      limitContext: { provider: "codex", product: "chatgpt-codex", protocol: "responses" } }),
    api: createRawHttpForwarder({ ...options, baseUrl: config.apiBaseUrl,
      limitContext: { provider: "codex", product: "openai-api", protocol: "responses" } }),
  };
  const sockets = new Set<Duplex>();
  const pending = new Set<http.ClientRequest>();

  return {
    http: (req, res, mode, path, body, headers, hooks) => forwarders[mode](req, res, body, path, headers, hooks),
    upgrade(req, socket, head, mode, path, rawHeaders) {
      if (req.method !== "GET" || req.headers.upgrade?.toLowerCase() !== "websocket") {
        rejectCodexUpgrade(req, socket, 400, "expected a WebSocket upgrade");
        return;
      }
      budget.run(socket, () => {
        const target = targets[mode];
        const client = target.protocol === "https:" ? https : http;
        socket.pause();
        sockets.add(socket);
        const upstream = client.request({
          protocol: target.protocol,
          hostname: target.hostname.replace(/^\[|\]$/g, ""),
          ...(target.port ? { port: Number(target.port) } : {}),
          method: "GET",
          path: `${target.pathname.replace(/\/$/, "")}${path}`,
          agent: false,
        });
        pending.add(upstream);
        let settled = false;
        let tunnel: Duplex | undefined;
        const fail = (status: number, message: string) => {
          if (settled || socket.destroyed) return;
          settled = true;
          rejectCodexUpgrade(req, socket, status, message);
          upstream.destroy();
        };
        socket.on("error", () => {
          upstream.destroy();
          tunnel?.destroy();
        });
        socket.once("close", () => {
          settled = true;
          sockets.delete(socket);
          upstream.destroy();
          tunnel?.destroy();
        });
        upstream.once("close", () => {
          pending.delete(upstream);
        });
        boundTcpConnect(upstream, config.connectTimeoutMs);
        upstream.once("timeout", () => fail(504, "upstream timed out"));
        upstream.once("error", () => fail(502, "upstream connection failed"));
        upstream.once("response", (response) => {
          if (settled || socket.destroyed) {
            response.destroy();
            return;
          }
          settled = true;
          observeNodeResponse(logger, { provider: "codex", product: mode === "subscription" ? "chatgpt-codex" : "openai-api", protocol: "responses" }, response);
          // A rejected upgrade is still an upstream HTTP response. Relay its status,
          // error body and Retry-After through Node so chunk framing remains correct.
          const downstream = new http.ServerResponse(req);
          downstream.assignSocket(req.socket);
          downstream.once("finish", () => socket.end());
          downstream.writeHead(response.statusCode ?? 502, [
            ...filterRawHeaders(response.rawHeaders, RESPONSE_STRIP),
            "Connection",
            "close",
          ]);
          response.on("error", () => socket.destroy());
          response.pipe(downstream);
          socket.resume();
        });
        upstream.once("upgrade", (response, upstreamSocket, upstreamHead) => {
          if (settled || socket.destroyed) {
            upstreamSocket.destroy();
            return;
          }
          settled = true;
          pending.delete(upstream);
          tunnel = upstreamSocket;
          sockets.add(tunnel);
          upstreamSocket.on("error", () => socket.destroy());
          upstreamSocket.once("close", () => {
            sockets.delete(upstreamSocket);
            socket.destroy();
          });
          const headers = filterRawHeaders(response.rawHeaders, RESPONSE_STRIP);
          let wire = `HTTP/1.1 101 ${response.statusMessage ?? "Switching Protocols"}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n`;
          for (let i = 0; i < headers.length; i += 2) wire += `${headers[i]}: ${headers[i + 1]}\r\n`;
          socket.write(`${wire}\r\n`);
          // Preserve bytes already read during both upgrade handshakes before piping.
          if (logger.recordLimit) {
            const observer = new LimitWebSocketObserver(logger, { provider: "codex",
              product: mode === "subscription" ? "chatgpt-codex" : "openai-api", protocol: "responses" });
            if (upstreamHead.length) observer.write(upstreamHead);
            upstreamSocket.pause();
            upstreamSocket.on("data", chunk => observer.write(Buffer.from(chunk)));
          }
          if (upstreamHead.length) socket.write(upstreamHead);
          if (head.length) upstreamSocket.write(head);
          upstreamSocket.pipe(socket);
          socket.pipe(upstreamSocket);
          socket.resume();
        });
        setRawRequestHeaders(upstream, filterRawHeaders(rawHeaders ?? req.rawHeaders, HOP_BY_HOP));
        upstream.setHeader("Connection", "Upgrade");
        upstream.setHeader("Upgrade", "websocket");
        upstream.end();
      });
    },
    close() {
      budget.close();
      for (const request of pending) request.destroy();
      for (const socket of sockets) socket.destroy();
      forwarders.subscription.close();
      forwarders.api.close();
    },
  };
}
