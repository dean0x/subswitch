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
import { destinationProtocol, destinationUrl, validatesNativeThinking } from "./destination-catalog.js";
import { classifyFailure, logProviderFailure } from "./provider-failure.js";
import { validatedProviderEvents } from "./provider-stream.js";
import { AttemptFailure } from "./attempt-failure.js";
export { AttemptFailure } from "./attempt-failure.js";
import type { ActionStore } from "./action-store.js";
import { ownerKey } from "./continuation-store.js";
import { ProfileAuth, type BoundCredential } from "./profile-auth.js";
import {
  RoutingError,
  type AccessProfile,
  type Item,
  type WireProtocol,
  type ClientEvent,
  type RouteTarget,
  type ActionContext,
  type OriginatingClient,
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
import { observeThinking, rememberThinking } from "./signed-thinking.js";
import { deriveConversationKey } from "../conversation-key.js";
import { recordLimitFailure, type LimitContext } from "../limit-observation.js";
import { observeCodexQuota } from "../codex-quota-snapshot.js";
import { abortable } from "../abortable.js";
import { identifyProviderEvents } from "./provider-identity.js";

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
  route?: string;
  attempt?: number;
  scopeHash?: string;
  /** Internal existing ActionStore context; never derived from caller history. */
  action?: Readonly<ActionContext>;
  /** Original request receipt from the owning ActionStore. */
  admissionSignal?: AbortSignal;
  allowNativeThinkingReplay?: boolean;
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
  );
  constructor(
    readonly auth: ProfileAuth,
    private readonly logger: Logger,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly clock: RoutingClock = systemClock,
    private readonly codexUserAgent = "subswitch",
    /** The existing owning store, never a request callback or a second registry. */
    private readonly actions?: ActionStore,
  ) {}
  validateAction(context: Readonly<ActionContext> | undefined, client: OriginatingClient, admissionSignal?: AbortSignal): void {
    if (!context || !this.actions) throw new RoutingError("action_identity_required", 409);
    this.actions.validateContext(context, client, admissionSignal);
  }
  async prepare(request: AttemptRequest): Promise<RoutedPrepared> {
    const { profile: p, target: t, protocol: ingress, signal, conversation } = request;
    const action = request.action ? Object.freeze({ ...request.action }) : undefined;
    const admissionSignal = request.admissionSignal;
    const client = ingress === "messages" ? "claude-code" : "codex";
    const protocol = destinationProtocol(p, ingress);
    const validateAction = () => this.validateAction(action, client, admissionSignal);
    if (action) validateAction();
    let credential = request.credential ?? (await this.auth.get(t.profile, signal));
    if (action) validateAction();
    this.auth.validate(credential);
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
    const controller = new AbortController();
    const combined = AbortSignal.any([signal, controller.signal, ...(admissionSignal ? [admissionSignal] : [])]);
    const dispose = () => {
      combined.removeEventListener("abort", dispose);
      stage.dispose();
    };
    combined.addEventListener("abort", dispose, { once: true });
    try {
      combined.throwIfAborted();
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
      stage.preflight();
      const encodedRequest = JSON.stringify(outbound);
      const dispatch = () => {
        combined.throwIfAborted();
        this.auth.validate(credential);
        if (action) validateAction();
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
        return abortable(Promise.resolve().then(() => {
          combined.throwIfAborted();
          if (action) validateAction();
          return this.fetchImpl(destinationUrl(p, protocol), {
            method: "POST",
            headers,
            body: encodedRequest,
            redirect: "error",
            signal: combined,
          });
        }), combined);
      };
      let response: Response;
      try {
        response = await dispatch();
        if (
          response.status === 401 &&
          p.credential.kind === "native-oauth" &&
          !request.refreshes.has(t.profile)
        ) {
          request.refreshes.add(t.profile);
          await readBoundedBody(response.body, 64 * 1024, combined);
          if (action) {
            combined.throwIfAborted();
            validateAction();
          }
          const refreshed = await this.auth.refresh(t.profile, combined);
          if (refreshed.generation !== credential.generation)
            throw new RoutingError("credential_owner_changed", 409);
          credential = refreshed;
          response = await dispatch();
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
      const limitContext: LimitContext = { provider: p.provider, product: p.product, protocol, profile: t.profile, model: t.model,
        ingress, configuredCredentialKind: "native-oauth",
        ...(request.scopeHash ? { scopeHash: request.scopeHash } : {}),
        ...(request.route ? { route: request.route } : {}), ...(request.attempt !== undefined ? { attempt: request.attempt } : {}) };
      observeCodexQuota(this.logger, limitContext, p.credential.authFile, response.headers);
      if (!response.ok) {
        const body = await readBoundedBody(response.body, 64 * 1024, combined);
        recordLimitFailure(this.logger, limitContext, { transport: "http", status: response.status, committed: false,
          headers: response.headers, text: body.text, truncated: body.truncated || !body.complete });
        const failure = classifyFailure(
          p,
          response.status,
          body,
          this.clock.now(),
          response.headers.get("retry-after"),
        );
        logProviderFailure(this.logger, "http_response", failure.kind, response.status);
        throw new AttemptFailure(failure);
      }
      const stageSnapshots = (final: Item) => {
        if (Array.isArray(final["content"]))
          for (const value of final["content"]) {
            const item = object(value);
            if (item) rememberThinking(stage, owner, conversation, item, validatesNativeThinking(p));
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
      };
      const raw = validatedProviderEvents(
        response, p, protocol, combined, controller, this.clock,
        stageSnapshots,
        this.logger,
        limitContext,
        block => observeThinking(stage, owner, conversation, block, validatesNativeThinking(p)),
      );
      let converted: AsyncIterable<ClientEvent>;
      if (protocol === ingress) converted = identifyProviderEvents(raw, protocol);
      else if (ingress === "responses") {
        if (!reverse) throw new RoutingError("adapter_missing", 500);
        converted = identifyProviderEvents(
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
      commit: () => {
        try {
          combined.throwIfAborted();
          if (action) validateAction();
          stage.commit();
        } finally { dispose(); }
      },
        cancel: async () => {
          dispose();
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
    } catch (error) {
      dispose();
      throw error;
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
