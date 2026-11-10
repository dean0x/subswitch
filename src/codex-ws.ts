import { boundTcpConnect } from "./tcp-connect.js";
import http, { type IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocket, WebSocketServer } from "ws";
import type { Config } from "./config.js";
import type { Logger } from "./logger.js";
import { rejectCodexUpgrade, type OpenaiPassthrough } from "./openai-passthrough.js";
import type { CodexNativeAuth } from "./codex-native-auth.js";
import type { WebSocketBudget } from "./websocket-budget.js";
import { RoutingError, type ActionContext } from "./routing/routing-types.js";
import { AttemptFailure } from "./routing/attempt-failure.js";
import type { CodexEndpointMode } from "./codex-ingress.js";
import { filterRawHeaders, HOP_BY_HOP, RESPONSE_STRIP } from "./raw-http-passthrough.js";
import { json } from "./codex-body.js";
import { namespaceEvent } from "./collaboration-compat.js";
import { object, type ObjectValue as Item } from "./plain-object.js";
import { claudeFailure, ClaudeHttpError, ReverseContractError } from "./claude-errors.js";
import { abortable } from "./abortable.js";
import { validatedRetryAt } from "./routing/provider-failure.js";
import type { ScopedSocket } from "./routing/scoped-lifecycle.js";
import { observeNodeResponse } from "./limit-http-observer.js";
import { recordLimitEvent } from "./limit-observation.js";
import { openaiWebSocketError } from "./errors.js";
import { OPENAI_EVENTS } from "./provider-events.js";
import { decideCodexRoute, rejectionError, type ClaudeResolution } from "./codex-route.js";

/** Owns handshake, client/upstream bridging, cancellation, and upgraded socket teardown. */
export class CodexWebSockets {
  private readonly wss: WebSocketServer;
  private readonly upstreamSockets = new Set<WebSocket>();
  private readonly pendingUpgrades = new Set<Duplex>();
  private closed = false;
  constructor(
    private readonly options: {
      config: Config;
      logger: Logger;
      raw: OpenaiPassthrough;
      nativeAuth: CodexNativeAuth;
      budget: WebSocketBudget;
      controllers: Set<AbortController>;
      destination: (body: Item) => ClaudeResolution;
      parentRequest: (body: Item) => Item;
      events: (body: Item, model: string, signal: AbortSignal, session?: string, req?: IncomingMessage,
        admission?: { signal: AbortSignal; context: ActionContext }) => AsyncGenerator<Item>;
      context?: (req: IncomingMessage, body: Item) => ActionContext | undefined;
      explicitRoutes?: boolean;
      scopedSocket?: (req: IncomingMessage, socket: Duplex) => ScopedSocket | undefined;
      correlation: (req: IncomingMessage) => string | undefined;
    },
  ) {
    this.wss = new WebSocketServer({ noServer: true, maxPayload: options.config.limits.maxBufferedBodyBytes });
  }
  close(): void {
    this.closed = true;
    for (const socket of this.pendingUpgrades) socket.destroy();
    for (const socket of this.wss.clients) socket.terminate();
    for (const socket of this.upstreamSockets) socket.terminate();
    this.wss.close();
  }
  private target(mode: CodexEndpointMode, path: string): URL {
    return new URL(
      `${(mode === "subscription" ? this.options.config.codexIngress.subscriptionBaseUrl : this.options.config.codexIngress.apiBaseUrl).replace(/\/$/, "")}${path}`,
    );
  }
  upgrade(req: IncomingMessage, socket: Duplex, head: Buffer, mode: CodexEndpointMode, path: string): void {
    if (req.method !== "GET" || req.headers.upgrade?.toLowerCase() !== "websocket") {
      rejectCodexUpgrade(req, socket, 400, "expected a WebSocket upgrade");
      return;
    }
    let scoped: ScopedSocket | undefined;
    try {
      scoped = this.options.scopedSocket?.(req, socket);
      if (scoped && path.split("?")[0] !== "/responses") throw new RoutingError("scoped_websocket_endpoint_unsupported", 400);
    } catch (error) {
      const failure = claudeFailure(error);
      rejectCodexUpgrade(req, socket, failure.status, failure.message); return;
    }
    this.options.budget.run(socket, () => {
      if ((this.options.explicitRoutes || scoped) && path.split("?")[0] === "/responses") {
        this.wss.handleUpgrade(req, socket, head, client => this.localBridge(req, client, mode, path, scoped));
        return;
      }
      socket.pause();
      this.pendingUpgrades.add(socket);
      socket.once("close", () => this.pendingUpgrades.delete(socket));
      void this.options.nativeAuth
        .headers(req, mode, path)
        .then((headers) => {
          if (!this.closed && !socket.destroyed) this.upgradeReady(req, socket, head, mode, path, headers);
        })
        .catch((error) => {
          const failure = claudeFailure(error);
          rejectCodexUpgrade(req, socket, failure.status, failure.message);
        });
    });
  }
  /** Local routed sockets authenticate a native destination only if a message selects it. */
  private localBridge(req: IncomingMessage, client: WebSocket, mode: CodexEndpointMode, path: string, scoped?: ScopedSocket): void {
    const active = new Map<string, AbortController>();
    const nativeRequests = new Map<string, () => void>();
    const releaseNative = (key: string) => {
      const release = nativeRequests.get(key); if (!release) return;
      for (const [alias, candidate] of nativeRequests) if (candidate === release) nativeRequests.delete(alias);
      release();
    };
    let parent: WebSocket | undefined, connecting: Promise<WebSocket> | undefined;
    const parentLifetime = new AbortController();
    const nativeSignal = scoped ? AbortSignal.any([parentLifetime.signal, scoped.signal]) : parentLifetime.signal;
    this.options.controllers.add(parentLifetime);
    let queued = 0;
    const send = (event: Item): Promise<void> => new Promise((resolve, reject) => {
      const encoded = JSON.stringify(event);
      if (client.readyState !== WebSocket.OPEN) { resolve(); return; }
      if (client.bufferedAmount + Buffer.byteLength(encoded) > 32 * 1024 * 1024) { client.close(1009, "send_queue_limit"); reject(new RoutingError("websocket_send_queue_limit", 502)); return; }
      client.send(encoded, error => error ? reject(error) : resolve());
    });
    const failure = (error: unknown, streamId?: string) => {
      const result = error instanceof RoutingError ? { status: error.status, code: error.code, message: error.code } :
        error instanceof AttemptFailure ? { status: error.clientStatus, code: error.clientCode, message: error.clientCode,
          ...(error.failure.retryAt !== undefined ? { retryAfter: String(Math.max(0, Math.ceil((error.failure.retryAt - Date.now()) / 1000))) } : {}),
        } : claudeFailure(error);
      return send(openaiWebSocketError(result, streamId)).catch(() => undefined);
    };
    const openParent = async (refreshed = false): Promise<WebSocket> => {
      nativeSignal.throwIfAborted();
      if (this.closed || client.readyState !== WebSocket.OPEN) throw new RoutingError("client_cancelled", 499);
      const nativeHeaders = await abortable(
        this.options.nativeAuth.headers(req, mode, path, refreshed), nativeSignal,
      );
      nativeSignal.throwIfAborted();
      if (this.closed || client.readyState !== WebSocket.OPEN) throw new RoutingError("client_cancelled", 499);
      return new Promise<WebSocket>((resolve, reject) => {
        const target = this.target(mode, path); target.protocol = target.protocol === "https:" ? "wss:" : "ws:";
        const flat = filterRawHeaders(nativeHeaders, new Set([...HOP_BY_HOP, "sec-websocket-key", "sec-websocket-version", "sec-websocket-extensions", "sec-websocket-protocol"]));
        const headers: Record<string, string> = {}; for (let i = 0; i < flat.length; i += 2) headers[flat[i]!] = flat[i + 1]!;
        const protocols = typeof req.headers["sec-websocket-protocol"] === "string"
          ? req.headers["sec-websocket-protocol"].split(",").map(value => value.trim()) : [];
        const upstream = new WebSocket(target, protocols, { headers, maxPayload: this.options.config.limits.maxBufferedBodyBytes,
          finishRequest: request => { boundTcpConnect(request, this.options.config.codexIngress.connectTimeoutMs); request.end(); } });
        parent = upstream; this.upstreamSockets.add(upstream);
        let opened = false, retrying = false;
        upstream.once("open", () => {
          if (nativeSignal.aborted || this.closed || client.readyState !== WebSocket.OPEN) {
            upstream.terminate(); reject(new RoutingError("client_cancelled", 499)); return;
          }
          opened = true; resolve(upstream);
        });
        upstream.on("error", error => { if (!retrying) reject(error); });
        upstream.once("unexpected-response", (_request, response) => {
          observeNodeResponse(this.options.logger, { provider: "codex", product: mode === "subscription" ? "chatgpt-codex" : "openai-api", protocol: "responses" }, response);
          if (response.statusCode === 401 && !refreshed && this.options.nativeAuth.canRefresh(req, mode, path)) {
            retrying = true;
            response.destroy(); upstream.terminate();
            void openParent(true).then(resolve, reject);
            return;
          }
          const status = response.statusCode ?? 502;
          const now = Date.now(), rawRetry = response.headers["retry-after"];
          const retryAt = validatedRetryAt(typeof rawRetry === "string" ? rawRetry : null, now);
          response.destroy(); upstream.terminate();
          reject(new ClaudeHttpError(status, "Native OpenAI WebSocket upgrade rejected.", "openai_websocket_rejected",
            retryAt === undefined ? undefined : String(Math.ceil((retryAt - now) / 1000))));
        });
        upstream.once("close", () => {
          this.upstreamSockets.delete(upstream);
          if (opened && !retrying && client.readyState === WebSocket.OPEN) client.close(1012, "Reconnect native stream");
        });
        let outputQueue = Promise.resolve(), count = 0;
        upstream.on("message", data => {
          if (++count > 16) { upstream.terminate(); return; }
          upstream.pause(); outputQueue = outputQueue.then(async () => {
            const event = namespaceEvent(json(Buffer.from(data.toString())));
            recordLimitEvent(this.options.logger, { provider: "codex", product: mode === "subscription" ? "chatgpt-codex" : "openai-api", protocol: "responses" }, event, "websocket", { truncated: (Buffer.isBuffer(data) ? data.length : data instanceof ArrayBuffer ? data.byteLength : data.reduce((sum, chunk) => sum + chunk.length, 0)) > 65536 });
            const incomingStream = event["stream_id"];
            const key = typeof incomingStream === "string" && incomingStream ? incomingStream : "default";
            const response = object(event["response"]), release = nativeRequests.get(key);
            if (release && typeof response?.["id"] === "string") nativeRequests.set(response["id"], release);
            await send(event);
            if (["response.completed", "response.incomplete", "response.failed", "response.cancelled", "error"].includes(String(event["type"]))) releaseNative(key);
          }).catch(async error => { await failure(error); if (scoped) upstream.terminate(); })
            .finally(() => { if (--count === 0 && upstream.readyState === WebSocket.OPEN) upstream.resume(); });
        });
      });
    };
    const connectParent = (): Promise<WebSocket> => {
      if (connecting) return connecting;
      connecting = openParent().catch(error => { connecting = undefined; throw error; });
      return connecting;
    };
    client.on("error", () => undefined);
    client.once("close", () => {
      parentLifetime.abort(); this.options.controllers.delete(parentLifetime);
      for (const c of active.values()) c.abort(); parent?.terminate();
      for (const key of nativeRequests.keys()) releaseNative(key);
    });
    client.on("message", data => {
      if (this.closed || client.readyState !== WebSocket.OPEN || scoped?.signal.aborted) return;
      let body: Item;
      try { body = json(Buffer.from(data.toString())); } catch (error) { failure(error); return; }
      const streamId = typeof body["stream_id"] === "string" ? body["stream_id"] : undefined;
      if (body["type"] === "response.cancel") {
        const id = String(body["response_id"] ?? streamId ?? "default");
        const c = active.get(id); if (c) { c.abort(); return; }
        if (id.startsWith("resp_subswitch_")) return;
      }
      let route: ReturnType<typeof decideCodexRoute>;
      try { route = decideCodexRoute("/responses", this.options.destination(body)); }
      catch (error) { failure(error, streamId); return; }
      if (route.kind === "rejected") { failure(rejectionError(route), streamId); return; }
      if (route.kind === "parent") {
        if (++queued > 16) { client.close(1009, "request_queue_limit"); return; }
        const key = streamId || "default";
        const generating = body["type"] !== "response.cancel";
        if (scoped && generating) {
          try {
            scoped.check();
            if (nativeRequests.has(key) || new Set(nativeRequests.values()).size >= 16) throw new RoutingError("concurrent_native_stream_id", 409);
            nativeRequests.set(key, body["generate"] === false ? () => undefined : scoped.admit());
          } catch (error) { queued--; failure(error, streamId); return; }
        }
        let forwarded = false;
        void connectParent().then(upstream => {
          const payload = JSON.stringify(this.options.parentRequest(body));
          if (upstream.bufferedAmount + Buffer.byteLength(payload) > 32 * 1024 * 1024) throw new RoutingError("websocket_send_queue_limit", 502);
          if (upstream.readyState === WebSocket.OPEN) { upstream.send(payload); forwarded = true; }
          else throw new RoutingError("native_websocket_closed", 502);
        }).catch(error => failure(error, streamId)).finally(() => {
          queued--; if (scoped && generating && !forwarded) releaseNative(key);
        });
        return;
      }
      const key = streamId ?? "default";
      if (active.has(key) || new Set(active.values()).size >= 16) { failure(new RoutingError("concurrent_route_stream_id", 409), streamId); return; }
      let release: () => void = () => undefined;
      let admission: { signal: AbortSignal; context: ActionContext } | undefined;
      if (scoped) {
        try {
          scoped.check();
          const context = this.options.context?.(req, body);
          if (!context) throw new RoutingError("action_identity_required", 409);
          admission = { signal: scoped.signal, context };
          if (body["generate"] !== false) release = scoped.admit();
        } catch (error) { failure(error, streamId); return; }
      }
      const controller = new AbortController(); active.set(key, controller); this.options.controllers.add(controller);
      const signal = scoped ? AbortSignal.any([controller.signal, scoped.signal]) : controller.signal;
      void (async () => {
        try {
          for await (const event of this.options.events(body, route.model, signal, this.options.correlation(req), req, admission)) {
            const response = object(event["response"]); if (typeof response?.["id"] === "string") active.set(response["id"], controller);
            await send({ ...event, ...(streamId ? { stream_id: streamId } : {}) });
          }
        } catch (error) { if (!signal.aborted) await failure(error, streamId); }
        finally { for (const [id, c] of active) if (c === controller) active.delete(id); this.options.controllers.delete(controller); release(); }
      })();
    });
    req.socket.resume();
  }
  private upgradeReady(
    req: IncomingMessage,
    socket: Duplex,
    head: Buffer,
    mode: CodexEndpointMode,
    path: string,
    nativeHeaders: readonly string[],
    refreshed = false,
  ): void {
    if (req.method !== "GET" || req.headers.upgrade?.toLowerCase() !== "websocket") {
      rejectCodexUpgrade(req, socket, 400, "expected a WebSocket upgrade");
      return;
    }
    if ((!this.options.config.codexIngress.claude.enabled && !this.options.explicitRoutes) || path.split("?")[0] !== "/responses") {
      this.pendingUpgrades.delete(socket);
      this.options.raw.upgrade(req, socket, head, mode, path, nativeHeaders);
      return;
    }
    const target = this.target(mode, path);
    target.protocol = target.protocol === "https:" ? "wss:" : "ws:";
    const flat = filterRawHeaders(
      nativeHeaders,
      new Set([
        ...HOP_BY_HOP,
        "sec-websocket-key",
        "sec-websocket-version",
        "sec-websocket-extensions",
        "sec-websocket-protocol",
      ]),
    );
    const headers: Record<string, string> = {};
    for (let index = 0; index < flat.length; index += 2) headers[flat[index]!] = flat[index + 1]!;
    const protocols =
      typeof req.headers["sec-websocket-protocol"] === "string"
        ? req.headers["sec-websocket-protocol"].split(",").map((value) => value.trim())
        : [];
    let upstream: WebSocket;
    try {
      upstream = new WebSocket(target, protocols, {
        headers,
        maxPayload: this.options.config.limits.maxBufferedBodyBytes,
        finishRequest: (request) => {
          boundTcpConnect(request, this.options.config.codexIngress.connectTimeoutMs);
          request.once("timeout", () =>
            request.destroy(Object.assign(new Error("OpenAI connection timed out"), { code: "ETIMEDOUT" })),
          );
          request.end();
        },
      });
    } catch {
      rejectCodexUpgrade(req, socket, 400, "invalid WebSocket handshake");
      return;
    }
    this.upstreamSockets.add(upstream);
    let accepted = false;
    const earlyClose = () => upstream.terminate();
    socket.once("close", earlyClose);
    upstream.once("unexpected-response", (_request, response) => {
      observeNodeResponse(this.options.logger, { provider: "codex", product: mode === "subscription" ? "chatgpt-codex" : "openai-api", protocol: "responses" }, response);
      accepted = true; // HTTP rejection owns the socket; do not assign a second response on close/error.
      if (response.statusCode === 401 && !refreshed && this.options.nativeAuth.canRefresh(req, mode, path)) {
        socket.off("close", earlyClose);
        response.destroy();
        upstream.terminate();
        void this.options.nativeAuth
          .headers(req, mode, path, true)
          .then((headers) => {
            if (!this.closed && !socket.destroyed) this.upgradeReady(req, socket, head, mode, path, headers, true);
          })
          .catch((error) => {
            const failure = claudeFailure(error);
            rejectCodexUpgrade(req, socket, failure.status, failure.message);
          });
        return;
      }
      this.options.logger.log("warn", OPENAI_EVENTS.websocketRejected, { status: response.statusCode ?? 502 });
      const local = new http.ServerResponse(req);
      local.assignSocket(req.socket);
      socket.resume();
      local.once("finish", () => socket.end());
      local.writeHead(response.statusCode ?? 502, filterRawHeaders(response.rawHeaders, RESPONSE_STRIP));
      response.pipe(local);
      response.once("end", () => upstream.terminate());
    });
    upstream.once("error", (error) => {
      if (!accepted)
        rejectCodexUpgrade(
          req,
          socket,
          (error as NodeJS.ErrnoException).code === "ETIMEDOUT" ? 504 : 502,
          "OpenAI WebSocket connection failed",
        );
    });
    upstream.once("close", () => this.upstreamSockets.delete(upstream));
    upstream.once("open", () => {
      if (socket.destroyed) {
        upstream.terminate();
        return;
      }
      this.wss.handleUpgrade(req, socket, head, (client) => {
        this.pendingUpgrades.delete(socket);
        accepted = true;
        socket.off("close", earlyClose);
        this.bridge(req, socket, client, upstream, mode);
      });
    });
  }
  private bridge(req: IncomingMessage, socket: Duplex, client: WebSocket, upstream: WebSocket, mode: CodexEndpointMode): void {
    const active = new Map<string, AbortController>();
    let forwardedOpenai = false;
    const send = (event: Item): Promise<void> =>
      new Promise((resolve, reject) => {
        if (client.readyState !== WebSocket.OPEN) {
          resolve();
          return;
        }
        client.send(JSON.stringify(event), (error) => (error ? reject(error) : resolve()));
      });
    const failure = (error: unknown, streamId?: string) => {
      const result = claudeFailure(error);
      void send(openaiWebSocketError(result, streamId)).catch(() => undefined);
    };
    client.on("error", () => undefined);
    client.once("close", () => {
      for (const controller of active.values()) controller.abort();
      upstream.terminate();
    });
    upstream.on("error", () => {
      if (forwardedOpenai && client.readyState === WebSocket.OPEN) client.close(1011, "OpenAI connection failed");
    });
    upstream.once("close", () => {
      if (forwardedOpenai && client.readyState === WebSocket.OPEN) client.close();
    });
    let responseQueue = Promise.resolve();
    let queuedResponses = 0;
    upstream.on("message", (data) => {
      upstream.pause();
      queuedResponses++;
      responseQueue = responseQueue
        .then(async () => {
          const event = namespaceEvent(json(Buffer.from(data.toString())));
          recordLimitEvent(this.options.logger, { provider: "codex", product: mode === "subscription" ? "chatgpt-codex" : "openai-api", protocol: "responses" }, event, "websocket", { truncated: (Buffer.isBuffer(data) ? data.length : data instanceof ArrayBuffer ? data.byteLength : data.reduce((sum, chunk) => sum + chunk.length, 0)) > 65536 });
          if (event["type"] === "response.completed") this.options.logger.log("info", OPENAI_EVENTS.responseComplete);
          await send(event);
        })
        .catch((error) => failure(error))
        .finally(() => {
          if (--queuedResponses === 0 && upstream.readyState === WebSocket.OPEN) upstream.resume();
        });
    });
    client.on("message", (data) => {
      if (this.closed || client.readyState !== WebSocket.OPEN) return;
      let body: Item;
      try {
        body = json(Buffer.from(data.toString()));
      } catch (error) {
        failure(error);
        return;
      }
      const streamId = typeof body["stream_id"] === "string" ? body["stream_id"] : undefined;
      if (body["type"] === "response.cancel") {
        const target = typeof body["response_id"] === "string" ? body["response_id"] : (streamId ?? "default");
        const controller = active.get(target);
        if (controller) {
          controller.abort();
          return;
        }
        if (target.startsWith("resp_subswitch_")) return;
      }
      let route: ReturnType<typeof decideCodexRoute>;
      try { route = decideCodexRoute("/responses", this.options.destination(body)); }
      catch (error) { failure(error, streamId); return; }
      if (route.kind === "rejected") {
        failure(rejectionError(route), streamId);
        return;
      }
      if (route.kind === "parent") {
        if (upstream.readyState !== WebSocket.OPEN) {
          client.close(1012, "Reconnect OpenAI stream");
          return;
        }
        try {
          forwardedOpenai = true;
          upstream.send(JSON.stringify(this.options.parentRequest(body)));
        } catch (error) {
          failure(error, streamId);
        }
        return;
      }
      const model = route.model;
      const key = streamId ?? "default";
      if (active.has(key)) {
        failure(new ReverseContractError("concurrent_claude_stream_id"), streamId);
        return;
      }
      const controller = new AbortController();
      active.set(key, controller);
      this.options.controllers.add(controller);
      void (async () => {
        try {
          for await (const event of this.options.events(
            body,
            model,
            controller.signal,
            this.options.correlation(req),
            req,
          )) {
            const response = object(event["response"]);
            if (typeof response?.["id"] === "string") active.set(response["id"], controller);
            await send({ ...event, ...(streamId ? { stream_id: streamId } : {}) });
          }
        } catch (error) {
          if (!controller.signal.aborted) failure(error, streamId);
        } finally {
          for (const [name, candidate] of active) if (candidate === controller) active.delete(name);
          this.options.controllers.delete(controller);
        }
      })();
    });
    socket.resume();
  }
}
