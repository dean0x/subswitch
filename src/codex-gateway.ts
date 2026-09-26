import { CodexWebSockets } from "./codex-ws.js";
import { CodexUpstream } from "./codex-upstream.js";
import { json, inputItems } from "./codex-body.js";
import { decideCodexRoute, rejectionError, unregisteredClaudeMessage, type ClaudeResolution } from "./codex-route.js";
import { isClaudeModelName } from "./claude-models.js";
import { CLAUDE_EVENTS, OPENAI_EVENTS } from "./provider-events.js";
import { WebSocketBudget } from "./websocket-budget.js";
import { CodexNativeAuth } from "./codex-native-auth.js";
import { type IncomingMessage, type ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import { randomUUID, createHash } from "node:crypto";
import { decodeBody as decode } from "./content-encoding.js";
import { claudeFailure } from "./claude-errors.js";
import type { Config } from "./config.js";
import type { Logger } from "./logger.js";
import { createOpenaiPassthrough, type OpenaiPassthrough, type CodexIngressEntry } from "./openai-passthrough.js";
import { type ForwardedBody } from "./raw-http-passthrough.js";
import { sniffLeadingModel, MODEL_SNIFF_BYTES } from "./anthropic-parse.js";
import { namespaceRequest } from "./collaboration-compat.js";
import { object } from "./claude-contract.js";
import { type ClaudeAuth } from "./claude-auth.js";
import { ClaudeHandler, ClaudeHttpError } from "./claude-handler.js";
import { reverseEvents, ReverseContractError, type Item } from "./claude-adapter.js";
import { ClaudeCache, type Snapshot } from "./claude-cache.js";
import { ReverseState } from "./claude-state.js";
import { createFrameWriter, drainRejectedUpload } from "./provider-transport.js";
import { SYNTHESIZED_HEADER, SYNTHESIZED_MARKER, openaiErrorBody, openaiFailureEvent } from "./errors.js";
import type { CodexEndpointMode } from "./codex-ingress.js";
import type { ProviderAuth } from "./provider-auth.js";

/** Reverse-enabled ingress: raw same-provider forwarding, scoped collaboration adaptation, Claude dispatch. */
export class CodexGateway implements CodexIngressEntry {
  private readonly raw: OpenaiPassthrough;
  private readonly upstream: CodexUpstream;
  private readonly webSockets: CodexWebSockets;
  private readonly claude: ClaudeHandler;
  private readonly resolve: (model: string) => string | undefined;
  private readonly cache: ClaudeCache;
  private readonly controllers = new Set<AbortController>();
  private closed = false;
  private readonly streams = new WeakMap<ServerResponse, { id: string; model: string; sequence: number }>();
  private readonly config: Config;
  private readonly logger: Logger;
  private readonly nativeAuth: CodexNativeAuth;
  constructor(options: {
    config: Config;
    logger: Logger;
    claudeAuth: ClaudeAuth;
    resolveClaude: (model: string) => string | undefined;
    parentAuth?: ProviderAuth<"codex">;
    fetchImpl?: typeof fetch;
  }) {
    const { config, logger, claudeAuth, fetchImpl, parentAuth } = options;
    this.config = config;
    this.logger = logger;
    this.nativeAuth = new CodexNativeAuth(parentAuth);
    const provider = config.codexIngress.claude;
    const budget = new WebSocketBudget(config.codexIngress.maxUpstreamSockets);
    this.raw = createOpenaiPassthrough(config.codexIngress, logger, budget);
    this.resolve = options.resolveClaude;
    this.cache = new ClaudeCache(provider.reasoningCache);
    this.upstream = new CodexUpstream({
      config,
      logger,
      raw: this.raw,
      nativeAuth: this.nativeAuth,
      cache: this.cache,
      closed: () => this.closed,
      onError: (res, error) => this.httpError(res, error),
    });
    this.webSockets = new CodexWebSockets({
      config,
      logger,
      raw: this.raw,
      nativeAuth: this.nativeAuth,
      budget,
      controllers: this.controllers,
      destination: (body) => this.destination(body),
      parentRequest: (body) => this.parentRequest(body),
      events: (body, model, signal, session) => this.claudeEvents(body, model, signal, session),
      correlation: (req) => this.correlation(req),
    });
    this.claude = new ClaudeHandler(
      provider,
      claudeAuth,
      logger,
      fetchImpl,
      new ReverseState(undefined, provider.reasoningCache, this.cache),
    );
  }
  close(): void {
    this.closed = true;
    for (const controller of this.controllers) controller.abort();
    this.webSockets.close();
    this.raw.close();
  }
  http(req: IncomingMessage, res: ServerResponse, mode: CodexEndpointMode, path: string): void {
    if (this.closed) {
      this.httpError(res, new ClaudeHttpError(503, "SubSwitch is shutting down.", "proxy_closing"));
      return;
    }
    void this.handleHttp(req, res, mode, path).catch((error) => this.httpError(res, error));
  }
  private httpError(res: ServerResponse, error: unknown): void {
    if (res.destroyed || res.writableEnded) return;
    const failure = claudeFailure(error);
    this.logger.log("warn", CLAUDE_EVENTS.requestFailed, { status: failure.status, errorCode: failure.code });
    if (res.headersSent) {
      const stream = this.streams.get(res);
      res.end(
        `data: ${JSON.stringify(
          openaiFailureEvent(
            failure.message,
            failure.code,
            stream ?? {
              id: `resp_subswitch_${randomUUID()}`,
              model: "",
              sequence: 0,
            },
          ),
        )}\n\n`,
      );
      this.streams.delete(res);
    } else {
      res.writeHead(failure.status, {
        "content-type": "application/json",
        [SYNTHESIZED_HEADER]: SYNTHESIZED_MARKER,
        ...(failure.retryAfter ? { "retry-after": failure.retryAfter } : {}),
      });
      res.end(openaiErrorBody(failure.message, failure.code));
    }
  }
  private async readBody(req: IncomingMessage): Promise<ForwardedBody> {
    const parts: Buffer[] = [];
    let bytes = 0;
    for await (const chunk of req.iterator({ destroyOnReturn: false })) {
      bytes += chunk.length;
      parts.push(chunk);
      if (bytes > this.config.limits.maxBufferedBodyBytes) return { kind: "prefix", bytes: Buffer.concat(parts) };
    }
    return { kind: "complete", bytes: Buffer.concat(parts) };
  }
  private fullRequest(body: Item, model: string): Item {
    const previous = body["previous_response_id"];
    if (previous !== undefined && previous !== null && typeof previous !== "string")
      throw new ReverseContractError("invalid_previous_response_id");
    let snapshot: Snapshot | undefined;
    if (typeof previous === "string") {
      snapshot = this.cache.get("snapshot", previous);
      if (!snapshot) throw new ReverseContractError("missing_continuation_state");
      if (snapshot.request["model"] !== model) throw new ReverseContractError("cross_provider_state_unavailable");
    }
    const full: Item = {
      ...snapshot?.request,
      ...body,
      model,
      input: [...(snapshot?.input ?? []), ...inputItems(body["input"])],
    };
    delete full["previous_response_id"];
    if (body["generate"] !== false) delete full["generate"];
    return full;
  }
  private resolveName(name: string): ClaudeResolution {
    const model = this.resolve(name);
    if (model) return { kind: "claude", model };
    return isClaudeModelName(name) ? { kind: "unregistered", name } : { kind: "foreign" };
  }
  private destination(body: Item): ClaudeResolution {
    if (typeof body["model"] === "string") return this.resolveName(body["model"]);
    if (typeof body["previous_response_id"] === "string") {
      const snapshot = this.cache.get("snapshot", body["previous_response_id"]);
      if (typeof snapshot?.request["model"] === "string") return this.destination(snapshot.request);
    }
    return { kind: "absent" };
  }
  private correlation(req: IncomingMessage): string | undefined {
    const value = req.headers["thread-id"] ?? req.headers["session-id"];
    return typeof value === "string" && value.length <= 1024
      ? createHash("sha256").update(value).digest("hex").slice(0, 8)
      : undefined;
  }
  private async *claudeEvents(
    body: Item,
    model: string,
    signal: AbortSignal,
    sessionKey?: string,
  ): AsyncGenerator<Item> {
    const full = this.fullRequest(body, model);
    if (body["generate"] === false) {
      const id = `resp_subswitch_${randomUUID()}`;
      this.cache.put("snapshot", id, { request: full, input: inputItems(full["input"]) });
      yield* reverseEvents(id, model, []);
      return;
    }
    if (
      inputItems(body["input"]).some((entry) =>
        ["function_call_output", "custom_tool_call_output"].includes(String(entry["type"])),
      )
    )
      this.logger.log("info", CLAUDE_EVENTS.toolResult, { model });
    for await (const event of this.claude.respond(full, signal, sessionKey)) {
      if (event["type"] === "response.completed") {
        const response = object(event["response"]);
        if (typeof response?.["id"] === "string" && Array.isArray(response["output"]))
          this.cache.put("snapshot", response["id"], {
            request: full,
            input: [...inputItems(full["input"]), ...inputItems(response["output"])],
          });
      }
      yield event;
    }
  }
  private parentRequest(body: Item): Item {
    if (typeof body["previous_response_id"] === "string" && body["previous_response_id"].startsWith("resp_subswitch_"))
      throw new ReverseContractError("cross_provider_state_unavailable");
    return namespaceRequest(body);
  }
  private async handleHttp(
    req: IncomingMessage,
    res: ServerResponse,
    mode: CodexEndpointMode,
    path: string,
  ): Promise<void> {
    if (!this.config.codexIngress.claude.enabled) {
      this.raw.http(req, res, mode, path, undefined, await this.nativeAuth.headers(req, mode, path));
      return;
    }
    const pathname = path.split("?")[0];
    if (req.method === "GET" && pathname === "/models") {
      await this.upstream.http(
        req,
        res,
        mode,
        path,
        undefined,
        "models",
        await this.nativeAuth.headers(req, mode, path),
      );
      return;
    }
    if (req.method !== "POST" || (pathname !== "/responses" && pathname !== "/responses/compact")) {
      this.raw.http(req, res, mode, path, undefined, await this.nativeAuth.headers(req, mode, path));
      return;
    }
    const consumed = await this.readBody(req);
    if (this.closed) throw new ClaudeHttpError(503, "SubSwitch is shutting down.", "proxy_closing");
    const raw = consumed.bytes;
    if (consumed.kind === "prefix") {
      const name = sniffLeadingModel(raw.subarray(0, MODEL_SNIFF_BYTES));
      const resolution = name === undefined ? undefined : this.resolveName(name);
      if (resolution?.kind === "claude" || resolution?.kind === "unregistered") {
        drainRejectedUpload(req);
        throw resolution.kind === "claude"
          ? new ReverseContractError("request_too_large")
          : new ReverseContractError("unregistered_claude_model", unregisteredClaudeMessage(resolution.name));
      }
      const headers = await this.nativeAuth.headers(req, mode, path);
      this.logger.log("warn", OPENAI_EVENTS.compatOverWindowPassthrough, { bodyMode: "streamed" });
      this.raw.http(req, res, mode, path, req.readableEnded ? { kind: "complete", bytes: raw } : consumed, headers);
      return;
    }
    let body: Item;
    try {
      body = json(await decode(raw, req.headers["content-encoding"], this.config.limits.maxBufferedBodyBytes));
    } catch {
      // An uninspectable request remains the original provider's responsibility.
      this.raw.http(
        req,
        res,
        mode,
        path,
        { kind: "complete", bytes: raw },
        await this.nativeAuth.headers(req, mode, path),
      );
      return;
    }
    const route = decideCodexRoute(pathname ?? "", this.destination(body));
    switch (route.kind) {
      case "parent": {
        const nativeHeaders = await this.nativeAuth.headers(req, mode, path);
        if (pathname === "/responses/compact") {
          this.forwardNative(req, res, mode, path, raw, nativeHeaders);
          return;
        }
        const mapped = this.parentRequest(body);
        const continuationAdapted =
          typeof body["previous_response_id"] === "string" && !!this.cache.get("adapted", body["previous_response_id"]);
        if (!continuationAdapted && mapped === body) {
          this.forwardNative(req, res, mode, path, raw, nativeHeaders);
        } else
          await this.upstream.http(
            req,
            res,
            mode,
            path,
            Buffer.from(JSON.stringify(mapped)),
            body["stream"] === true ? "namespace-stream" : "namespace",
            nativeHeaders,
          );
        return;
      }
      case "rejected":
        throw rejectionError(route);
      case "claude":
        return this.streamClaude(req, res, body, route.model);
      default: {
        const exhaustive: never = route;
        return exhaustive;
      }
    }
  }
  private forwardNative(
    req: IncomingMessage,
    res: ServerResponse,
    mode: CodexEndpointMode,
    path: string,
    body: Buffer,
    headers: readonly string[],
  ): void {
    if (this.nativeAuth.canRefresh(req, mode, path)) this.upstream.http(req, res, mode, path, body, "raw", headers);
    else this.raw.http(req, res, mode, path, { kind: "complete", bytes: body }, headers);
  }
  private async streamClaude(req: IncomingMessage, res: ServerResponse, body: Item, model: string): Promise<void> {
    const controller = new AbortController();
    this.controllers.add(controller);
    const close = () => {
      if (!res.writableFinished) controller.abort();
    };
    res.on("close", close);
    const write = createFrameWriter(res, controller.signal);
    let result: unknown;
    let ping: ReturnType<typeof setInterval> | undefined;
    try {
      for await (const event of this.claudeEvents(body, model, controller.signal, this.correlation(req))) {
        if (body["stream"] === true) {
          const response = object(event["response"]);
          const previous = this.streams.get(res);
          this.streams.set(res, {
            id: typeof response?.["id"] === "string" ? response["id"] : (previous?.id ?? ""),
            model,
            sequence:
              typeof event["sequence_number"] === "number" ? event["sequence_number"] : (previous?.sequence ?? 0),
          });
          if (!res.headersSent) {
            res.writeHead(200, {
              "content-type": "text/event-stream",
              "cache-control": "no-cache",
              [SYNTHESIZED_HEADER]: SYNTHESIZED_MARKER,
            });
            ping = setInterval(() => {
              if (!res.destroyed && res.writableLength < 65536) res.write(": ping\n\n");
            }, this.config.limits.pingIntervalMs);
          }
          await write(`data: ${JSON.stringify(event)}\n\n`);
        } else if (event["type"] === "response.completed" || event["type"] === "response.incomplete")
          result = event["response"];
      }
      if (body["stream"] !== true) {
        res.writeHead(200, { "content-type": "application/json", [SYNTHESIZED_HEADER]: SYNTHESIZED_MARKER });
        res.end(JSON.stringify(result));
      } else res.end();
    } finally {
      clearInterval(ping);
      res.off("close", close);
      this.controllers.delete(controller);
      if (res.writableEnded || res.destroyed) this.streams.delete(res);
    }
  }
  upgrade(req: IncomingMessage, socket: Duplex, head: Buffer, mode: CodexEndpointMode, path: string): void {
    this.webSockets.upgrade(req, socket, head, mode, path);
  }
}
