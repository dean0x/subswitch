import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createHmac, randomBytes, randomUUID } from "node:crypto";
import {
  createSseParser,
  createAnthropicSseTranslator,
  type SseEvent,
} from "../codex-response.js";
import { translateClaudeStream } from "../claude-stream.js";
import { ClaudeCache } from "../claude-cache.js";
import { ReverseState } from "../claude-state.js";
import { object } from "../plain-object.js";
import { readBoundedBody } from "../provider-transport.js";
import { destinationProtocol, destinationUrl } from "./destination-catalog.js";
import { classifyFailure } from "./provider-failure.js";
import { validatedProviderEvents } from "./provider-stream.js";
import { AttemptFailure } from "./attempt-failure.js";
export { AttemptFailure } from "./attempt-failure.js";
import { ownerKey } from "./continuation-store.js";
import { ProfileAuth, type BoundCredential } from "./profile-auth.js";
import {
  RoutingError,
  type AccessProfile,
  type Item,
  type WireProtocol,
  type ClientEvent,
  type RouteTarget,
} from "./routing-types.js";
import type { Logger } from "../logger.js";
import {
  decodePortableHistory,
  type PortableTranscript,
} from "./portable-history.js";
import { systemClock, type RoutingClock } from "./clock.js";
import { codexTransportConstants, buildHeaders } from "../codex-handler.js";
import { StagedCache } from "./replay-cache.js";
import { adaptRequest } from "./request-adapter.js";
import { deriveConversationKey } from "../conversation-key.js";

export interface AttemptRequest {
  profile: AccessProfile;
  target: RouteTarget;
  body: Item;
  protocol: WireProtocol;
  transcript?: PortableTranscript;
  credential?: BoundCredential;
  conversation: string;
  priorOwner?: string;
  expectedOwner?: string;
  signal: AbortSignal;
  refreshes: Set<string>;
}
export interface RoutedPrepared {
  events: AsyncIterable<ClientEvent>;
  owner: string;
  protocol: WireProtocol;
  commit(): void;
  cancel(): Promise<void>;
}

/** Provider attempts never receive ServerResponse. All writes and affinity live in the dispatcher. */
export class RoutedAttempts {
  private readonly key = randomBytes(32);
  private readonly replay = new ClaudeCache(
    { maxEntries: 2048, maxBytes: 32 * 1024 * 1024 },
    true,
  );
  constructor(
    readonly auth: ProfileAuth,
    private readonly logger: Logger,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly clock: RoutingClock = systemClock,
    private readonly codexUserAgent = "subswitch",
  ) {}
  async prepare(request: AttemptRequest): Promise<RoutedPrepared> {
    const {
      profile: p,
      target: t,
      protocol: ingress,
      signal,
      conversation,
    } = request;
    let credential =
      request.credential ?? (await this.auth.get(t.profile, signal));
    this.auth.validate(credential);
    const protocol = destinationProtocol(p, ingress);
    const owner = ownerKey(p, t, protocol, credential.generation);
    const sessionId = deriveConversationKey({
      model: owner,
      messages: [{ role: "user", content: conversation }],
    })!;
    if (request.expectedOwner && request.expectedOwner !== owner)
      throw new RoutingError("credential_owner_changed", 409);
    const transcript =
      request.transcript ?? decodePortableHistory(request.body, ingress);
    const stage = new StagedCache(this.replay);
    const replayKey = createHmac("sha256", this.key)
      .update(owner + conversation)
      .digest();
    const state = new ReverseState(replayKey, undefined, stage);
    const { outbound, reverse } = adaptRequest({
      ...request,
      ingress,
      protocol,
      transcript,
      stage,
      state,
      owner,
      sessionId,
    });
    const controller = new AbortController(),
      combined = AbortSignal.any([signal, controller.signal]);
    const encodedRequest = JSON.stringify(outbound);
    let response: Response;
    try {
      while (true) {
        combined.throwIfAborted();
        this.auth.validate(credential);
        let headers: Record<string, string> = {
          ...credential.authHeaders,
          "content-type": "application/json",
          accept: "text/event-stream",
        };
        if (protocol === "messages")
          headers["anthropic-version"] = "2023-06-01";
        if (p.product === "claude-code")
          headers["anthropic-beta"] = "claude-code-20250219,oauth-2025-04-20";
        if (p.product === "chatgpt-codex") {
          if (credential.provider !== "codex")
            throw new RoutingError("credential_binding_mismatch", 503);
          headers = buildHeaders(
            { provider: "codex", authHeaders: credential.authHeaders },
            sessionId,
            codexTransportConstants(this.codexUserAgent),
          );
        }
        response = await this.fetchImpl(destinationUrl(p, protocol), {
          method: "POST",
          headers,
          body: encodedRequest,
          redirect: "error",
          signal: combined,
        });
        if (
          response.status !== 401 ||
          p.credential.kind !== "native-oauth" ||
          request.refreshes.has(t.profile)
        )
          break;
        request.refreshes.add(t.profile);
        await readBoundedBody(response.body, 64 * 1024, combined);
        const refreshed = await this.auth.refresh(t.profile, combined);
        if (refreshed.generation !== credential.generation)
          throw new RoutingError("credential_owner_changed", 409);
        credential = refreshed;
      }
    } catch (error) {
      if (error instanceof RoutingError) throw error;
      if (combined.aborted) throw new RoutingError("request_cancelled", 499);
      throw new AttemptFailure({
        kind: "transport",
        evidence: "unknown",
        windows: [],
        bodyTruncated: false,
        responseCommitted: false,
      });
    }
    if (!response.ok)
      throw new AttemptFailure(
        classifyFailure(
          p,
          response.status,
          await readBoundedBody(response.body, 64 * 1024, combined),
          this.clock.now(),
          response.headers.get("retry-after"),
        ),
      );
    const raw = validatedProviderEvents(
      response,
      p,
      protocol,
      combined,
      controller,
      this.clock,
      (final) => {
        if (Array.isArray(final["content"]))
          for (const value of final["content"]) {
            const item = object(value),
              signature = item?.["signature"] ?? item?.["data"];
            if (typeof signature === "string")
              stage.put(
                "snapshot",
                `signature:${owner}:${conversation}:${signature}`,
                { request: {}, input: [item!] },
              );
          }
        if (Array.isArray(final["output"])) {
          const output = final["output"] as Item[],
            reasoning = output.filter((i) => i["type"] === "reasoning");
          for (const item of output) {
            if (
              item["type"] === "function_call" &&
              typeof item["call_id"] === "string"
            )
              stage.put(
                "snapshot",
                `reasoning:${owner}:${conversation}:${item["call_id"]}`,
                { request: {}, input: reasoning },
              );
            if (
              item["type"] === "reasoning" &&
              typeof item["encrypted_content"] === "string"
            )
              stage.put(
                "snapshot",
                `opaque:${owner}:${conversation}:${item["encrypted_content"]}`,
                { request: {}, input: [item] },
              );
          }
        }
      },
    );
    let converted: AsyncIterable<ClientEvent>;
    if (protocol === ingress) converted = this.identity(raw, protocol);
    else if (ingress === "responses") {
      if (!reverse) throw new RoutingError("adapter_missing", 500);
      converted = this.identity(
        translateClaudeStream(raw, {
          id: `resp_subswitch_${randomUUID()}`,
          model: t.model,
          request: reverse,
          state,
          maxBytes: 64 * 1024 * 1024,
        }),
        "responses",
      );
    } else {
      converted = this.forward(raw, t.model, (id, items) =>
        stage.put("snapshot", `reasoning:${owner}:${conversation}:${id}`, {
          request: {},
          input: items as Item[],
        }),
      );
    }
    const iterator = converted[Symbol.asyncIterator]();
    return {
      events: { [Symbol.asyncIterator]: () => iterator },
      owner,
      protocol: ingress,
      commit: () => stage.commit(),
      cancel: async () => {
        controller.abort();
        // Returning the generator clears idle timers and pipeline listeners even when
        // cancellation arrives while downstream is parked at a delivered event.
        let timer: ReturnType<typeof setTimeout> | undefined;
        const closing = Promise.allSettled([
          iterator.return?.(),
          response.body && !response.body.locked
            ? response.body.cancel()
            : undefined,
        ]);
        await Promise.race([
          closing,
          new Promise<void>((resolve) => {
            timer = setTimeout(resolve, 100);
          }),
        ]);
        clearTimeout(timer);
      },
    };
  }
  private async *identity(
    raw: AsyncIterable<Item | SseEvent>,
    protocol: WireProtocol,
  ): AsyncGenerator<ClientEvent> {
    for await (const value of raw) {
      const payload =
        "data" in value
          ? object(JSON.parse(String(value.data)))
          : (value as Item);
      if (!payload) throw new RoutingError("invalid_provider_event", 502);
      yield { protocol, payload };
    }
  }
  private async *forward(
    raw: AsyncIterable<SseEvent>,
    model: string,
    onReasoningItems: (id: string, items: readonly unknown[]) => void,
  ): AsyncGenerator<ClientEvent> {
    const translator = createAnthropicSseTranslator({
      model,
      logger: this.logger,
      providerId: "codex",
      onReasoningItems,
    });
    const parser = createSseParser(4 * 1024 * 1024),
      source = Readable.from(raw);
    const running = pipeline(source, translator, parser).catch((e) =>
      parser.destroy(e as Error),
    );
    try {
      for await (const event of parser as AsyncIterable<SseEvent>)
        yield { protocol: "messages", payload: JSON.parse(event.data) as Item };
    } finally {
      source.destroy();
      translator.destroy();
      parser.destroy();
      await running;
    }
  }
}
