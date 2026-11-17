import { CLAUDE_EVENTS } from "./provider-events.js";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { randomUUID } from "node:crypto";
import { createSseParser, type SseEvent } from "./codex-response.js";
import { reverseRequest, ReverseContractError, type Item } from "./claude-adapter.js";
import { translateClaudeStream } from "./claude-stream.js";
import { ReverseState } from "./claude-state.js";
import { CLAUDE_SUBSCRIPTION_PREAMBLE, object } from "./claude-contract.js";
import type { ClaudeProviderConfig } from "./config.js";
import type { ClaudeAuth } from "./claude-auth.js";
import type { Logger } from "./logger.js";
import { readBoundedText } from "./provider-transport.js";
import { redactCredentials } from "./errors.js";
import { SUBSWITCH_NAME, SUBSWITCH_VERSION } from "./version.js";
import { recordLimitFailure } from "./limit-observation.js";
import { observeReadableSse } from "./limit-http-observer.js";

import { ClaudeHttpError } from "./claude-errors.js";
export { ClaudeHttpError } from "./claude-errors.js";

export class ClaudeHandler {
  private readonly state: ReverseState;
  constructor(
    private readonly config: ClaudeProviderConfig,
    private readonly auth: ClaudeAuth,
    private readonly logger: Logger,
    private readonly fetchImpl: typeof fetch = fetch,
    state?: ReverseState,
  ) {
    this.state = state ?? new ReverseState(undefined, config.reasoningCache);
  }

  private async authorizedFetch(body: Item, signal: AbortSignal, model: string, trace: { sessionKey?: string }) {
    let credentials = await this.auth.getCredentials();
    signal.throwIfAborted();
    // These are the relay's Claude credentials. A 401 would make native Codex
    // refresh its unrelated OpenAI login instead of displaying the setup problem.
    if (!credentials.ok) throw new ClaudeHttpError(503, credentials.error.message, "claude_auth_unavailable");
    let response: Response | undefined;
    for (let attempt = 0; attempt < 2; attempt++) {
      const headers = {
        ...credentials.value.authHeaders,
        "content-type": "application/json",
        accept: "text/event-stream",
        "anthropic-version": "2023-06-01",
        "anthropic-beta": "claude-code-20250219,oauth-2025-04-20",
        "user-agent": `${SUBSWITCH_NAME}/${SUBSWITCH_VERSION}`,
      };
      response = await this.fetchImpl(`${this.config.baseUrl.replace(/\/$/, "")}/v1/messages`, {
        method: "POST",
        headers,
        body: JSON.stringify({ ...body, stream: true }),
        redirect: "error",
        signal,
      });
      if (response.status !== 401 || attempt === 1) break;
      await response.body?.cancel();
      this.logger.log("info", CLAUDE_EVENTS.upstream401Refreshing, { model, ...trace });
      credentials = await this.auth.forceRefresh();
      signal.throwIfAborted();
      if (!credentials.ok) throw new ClaudeHttpError(503, credentials.error.message, "claude_auth_unavailable");
    }
    if (!response) throw new ReverseContractError("claude_retry_bound");
    return { response, credentials };
  }

  async *respond(request: Item, externalSignal: AbortSignal, sessionKey?: string): AsyncGenerator<Item> {
    const controller = new AbortController();
    const signal = AbortSignal.any([externalSignal, controller.signal]);
    const timeout = setTimeout(() => controller.abort(), this.config.requestTimeoutMs);
    let idle: ReturnType<typeof setTimeout> | undefined;
    let source: Readable | undefined;
    let terminal = false;
    const started = Date.now(),
      model = String(request["model"]);
    const trace = sessionKey === undefined ? {} : { sessionKey };
    try {
      const translated = reverseRequest(
        { ...request, max_output_tokens: request["max_output_tokens"] ?? 64000 },
        [{ type: "text", text: CLAUDE_SUBSCRIPTION_PREAMBLE }],
        this.state,
      );
      const { response, credentials } = await this.authorizedFetch(translated.body, signal, model, trace);
      if (!response.ok) {
        let message = "Claude rejected the request.",
          code = "claude_upstream_error";
        const raw = await readBoundedText(response.body, this.config.maxSseEventBytes);
        recordLimitFailure(this.logger, { provider: "claude", product: "claude-code", protocol: "messages" },
          { transport: "http", status: response.status, committed: false, headers: response.headers,
            text: raw, truncated: Buffer.byteLength(raw) >= this.config.maxSseEventBytes || Buffer.byteLength(raw) > 65536 });
        try {
          const error = object(object(JSON.parse(raw))?.["error"]);
          if (typeof error?.["message"] === "string") message = error["message"];
          if (typeof error?.["type"] === "string" && /^[a-z_]{1,80}$/.test(error["type"])) code = error["type"];
        } catch {
          /* Never return upstream HTML or parser exceptions. */
        }
        const token = credentials.ok
          ? credentials.value.authHeaders["authorization"]?.replace(/^Bearer /, "")
          : undefined;
        message = redactCredentials(token ? message.replaceAll(token, "<redacted>") : message);
        this.logger.log("warn", CLAUDE_EVENTS.upstreamError, {
          model,
          ...trace,
          status: response.status,
          errorCode: code,
        });
        throw new ClaudeHttpError(response.status, message, code, response.headers.get("retry-after") ?? undefined);
      }
      if (!response.body) throw new ReverseContractError("missing_claude_body");
      source = Readable.fromWeb(response.body as import("node:stream/web").ReadableStream<Uint8Array>);
      observeReadableSse(this.logger, { provider: "claude", product: "claude-code", protocol: "messages" }, source, response.headers);
      const parser = createSseParser(this.config.maxSseEventBytes);
      const resetIdle = () => {
        clearTimeout(idle);
        idle = setTimeout(() => controller.abort(), this.config.streamIdleTimeoutMs);
      };
      source.on("data", resetIdle);
      resetIdle();
      const running = pipeline(source, parser, { signal }).catch((error) => {
        parser.destroy(error as Error);
      });
      try {
        for await (const event of translateClaudeStream(parser as AsyncIterable<SseEvent>, {
          id: `resp_subswitch_${randomUUID()}`,
          model,
          request: translated,
          state: this.state,
          maxBytes: this.config.maxAggregateBytes,
        })) {
          if (
            event["type"] === "response.output_item.done" &&
            ["function_call", "custom_tool_call"].includes(String(object(event["item"])?.["type"]))
          )
            this.logger.log("info", CLAUDE_EVENTS.toolCall, { model, ...trace });
          terminal = event["type"] === "response.completed" || event["type"] === "response.incomplete";
          if (terminal) {
            const usage = object(object(event["response"])?.["usage"]);
            const cached = object(usage?.["input_tokens_details"])?.["cached_tokens"];
            this.logger.log("info", CLAUDE_EVENTS.requestComplete, {
              model,
              ...trace,
              status: 200,
              latencyMs: Date.now() - started,
              ...(typeof cached === "number" ? { cachedTokens: cached } : {}),
            });
          }
          yield event;
          if (terminal) break;
        }
        await running;
      } finally {
        parser.destroy();
        await running;
      }
    } catch (error) {
      if (terminal && signal.aborted) return;
      if (signal.aborted && !externalSignal.aborted)
        throw new ClaudeHttpError(504, "Claude request timed out.", "claude_timeout");
      throw error;
    } finally {
      clearTimeout(timeout);
      clearTimeout(idle);
      source?.destroy();
    }
  }
}
