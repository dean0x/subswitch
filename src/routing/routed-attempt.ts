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
import { resolveDestination, destinationUrl, type DestinationSelection } from "./destination-catalog.js";
import { KimiResponsesBridgeError, renderValidatedKimiResponses } from "./kimi-responses-bridge.js";
import { classifyFailure, logProviderFailure, providerErrorHints } from "./provider-failure.js";
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
import { StagedCache, type OrderedReplayDiagnostics } from "./replay-cache.js";
import { adaptRequest } from "./request-adapter.js";
import { deriveConversationKey } from "../conversation-key.js";
import { recordLimitFailure, type LimitContext } from "../limit-observation.js";
import { abortable } from "../abortable.js";
import { identifyProviderEvents } from "./provider-identity.js";
import { KimiExecPending, type KimiExecReservation } from "./kimi-exec-pending.js";
import { KimiExecStream } from "./kimi-exec-stream.js";
import { prepareKimiExecTransaction, type KimiExecTransaction } from "./kimi-exec-transaction.js";
import { holdOrderedJson, orderedJsonBytes, prepareOrderedReplay, type OrderedLeases, type ObserveOrderedReplay } from "./kimi-ordered-replay.js";

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
  /** Original owning-store request receipt; selected Kimi still requires an active action. */
  admissionSignal?: AbortSignal;
  /** Resolved internally by SharedRouting; checked against the real action again here. */
  selection?: Readonly<DestinationSelection>;
}
export interface RoutedPrepared {
  events: AsyncIterable<ClientEvent>;
  owner: string;
  protocol: WireProtocol;
  /** Selected strict Kimi codec: all Messages frames validate before publication. */
  atomicMessages?: true;
  atomicPending?: KimiExecPending;
  /** Internal fabricated opt-in; no production prepare() constructs this context. */
  orderedResponsesSuffix?: {
    readonly pending: KimiExecPending;
    /** Stage validated associations only after final delivery preflights. Must be synchronous. */
    beforePublication(): undefined;
  };
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
    /** Qualification budget hook: invoked before EVERY physical inference dispatch, including401. */
    private readonly beforeDispatch?: (dispatch: { profile: string; protocol: WireProtocol; requestedOutputTokens: unknown }) => void,
    /** Internal fabricated integration only. SharedRouting and real entrypoints omit this. */
    private readonly createKimiExecPending?: () => KimiExecPending,
    /** The existing owning store, never a request callback or a second registry. */
    private readonly actions?: ActionStore,
    /** Private disposable qualification only; real entrypoints omit this observer. */
    private readonly observeKimiOrderedReplay?: ObserveOrderedReplay,
    /** Private value-free comparison only; real entrypoints omit this observer too. */
    private readonly orderedReplayDiagnostics?: OrderedReplayDiagnostics,
  ) {}
  validateAction(context: Readonly<ActionContext> | undefined, client: OriginatingClient, admissionSignal?: AbortSignal): void {
    if (!context || !this.actions) throw new RoutingError("action_identity_required", 409);
    this.actions.validateContext(context, client, admissionSignal);
  }
  async prepare(request: AttemptRequest): Promise<RoutedPrepared> {
    const {
      profile: p,
      target: t,
      protocol: ingress,
      signal,
      conversation,
      route,
    } = request;
    const action = request.action ? Object.freeze({ ...request.action }) : undefined;
    const admissionSignal = request.admissionSignal;
    const client = ingress === "messages" ? "claude-code" : "codex";
    const selection = resolveDestination(p, ingress, request.body, !!action && client === "claude-code");
    const validateAction = () => this.validateAction(action, client, selection.codec ? undefined : admissionSignal);
    if (action) validateAction();
    if (request.selection && (request.selection.protocol !== selection.protocol || request.selection.codec !== selection.codec))
      throw new RoutingError("destination_selection_mismatch", 409);
    const { protocol, codec } = selection;
    if (codec && !route) throw new RoutingError("action_identity_required", 409);
    let credential = request.credential ?? (await this.auth.get(t.profile, signal));
    if (action) validateAction();
    this.auth.validate(credential);
    const owner = ownerKey(p, t, protocol, credential.generation, codec);
    const sessionId = deriveConversationKey({
      model: owner,
      messages: [{ role: "user", content: conversation }],
    })!;
    if (request.expectedOwner && request.expectedOwner !== owner)
      throw new RoutingError("credential_owner_changed", 409);
    const transcript =
      request.transcript ?? decodePortableHistory(request.body, ingress);
    const stage = new StagedCache(this.replay, this.orderedReplayDiagnostics);
    const replayKey = createHmac("sha256", this.key)
      .update(owner + conversation)
      .digest();
    const state = new ReverseState(replayKey, undefined, stage);
    const orderedPending = codec ? new KimiExecPending() : undefined;
    const orderedLeases: OrderedLeases = [];
    let ordered: ReturnType<typeof prepareOrderedReplay> | undefined;
    let outbound: Item = {}, reverse: ReturnType<typeof adaptRequest>["reverse"];
    // Keep the selected preparation itself inside disposal, including pre-dispatch refusal.
    try {
    if (orderedPending) {
      stage.attachPending(orderedPending);
      holdOrderedJson(request.body, orderedPending, orderedLeases); // retained original controls/history
      holdOrderedJson(request.body, orderedPending, orderedLeases); // renderer's owned full-request clone
      // The closed renderer can expand a string-content message into three
      // wrappers. Reserve its bounded expansion before constructing that copy,
      // including fixed body framing. Later exact outbound/canonical copies are
      // charged separately; this reservation is never transferred or reset.
      orderedLeases.push(orderedPending.reserve(3 * orderedJsonBytes(request.body) + 256));
    }
    const adapted = adaptRequest({
      ...request,
      ingress,
      protocol,
      selection,
      transcript,
      stage,
      state,
      owner,
      sessionId,
    });
    outbound = adapted.outbound; reverse = adapted.reverse;
    if (orderedPending) {
      if (!adapted.orderedRender) throw new RoutingError("invalid_codec_publication", 500);
      ordered = prepareOrderedReplay({ context: action!, route: route!, profile: t.profile,
        owner, generation: credential.generation, source: request.body, rendered: adapted.orderedRender,
        outbound, stage, pending: orderedPending, leases: orderedLeases,
        observeIdentity: this.observeKimiOrderedReplay });
      outbound = { ...outbound, input: ordered.input };
      holdOrderedJson(outbound, orderedPending, orderedLeases);
    }
    } catch (error) {
      ordered = undefined; outbound = {}; stage.dispose();
      for (const lease of orderedLeases) lease.release();
      throw error;
    }
    let exec: KimiExecStream | undefined, transaction: KimiExecTransaction | undefined;
    let completion: { final: Item; calls: readonly Item[] } | undefined;
    let completionLease: KimiExecReservation | undefined;
    let publicationReady = false, disposed = false, orderedReady = false;
    const clearCompletion = () => {
      completion = undefined;
      completionLease?.release(); completionLease = undefined;
    };
    const dispose = () => {
      if (!exec && !codec) return;
      disposed = true;
      clearCompletion();
      ordered = undefined; outbound = {};
      stage.dispose();
      for (const lease of orderedLeases) lease.release();
      orderedLeases.length = 0;
    };
    try {
    // All original capability/history/opaque/credential guards above run first.
    const pending = codec ? undefined : this.createKimiExecPending?.();
    // The validated inventory includes late inline tools. Only proven absence
    // bypasses codec-only limits; unknown/potential exec still fails closed.
    const mapped = pending && transcript.hasResponsesExecDeclaration !== false && prepareKimiExecTransaction({ profile: p, target: t, body: outbound,
      ingress, protocol, stage, owner, conversation, credentialGeneration: credential.generation,
      attempt: randomUUID(), pending });
    if (mapped) {
      stage.attachPending(pending!);
      outbound = mapped.outbound;
      transaction = mapped.transaction;
      exec = new KimiExecStream(pending);
    }
    const controller = new AbortController(),
      combined = AbortSignal.any([signal, controller.signal, ...(admissionSignal ? [admissionSignal] : []), ...(p.provider === "kimi" && p.credential.kind === "native-oauth" ? [AbortSignal.timeout(30000)] : [])]);
    if (orderedPending) orderedLeases.push(orderedPending.reserve(2 * orderedJsonBytes(outbound) + 3));
    const encodedRequest = JSON.stringify(outbound);
    const serializedCap: unknown = this.beforeDispatch
      ? JSON.parse(encodedRequest)[protocol === "messages" ? "max_tokens" : "max_output_tokens"]
      : undefined;
    let response: Response;
    try {
      while (true) {
        combined.throwIfAborted();
        this.auth.validate(credential);
        if (action) validateAction();
        let headers: Record<string, string> = {
          ...this.auth.identity(credential),
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
        this.beforeDispatch?.({ profile: t.profile, protocol, requestedOutputTokens: serializedCap });
        response = await abortable(Promise.resolve().then(() => {
          combined.throwIfAborted();
          if (action) validateAction();
          if (codec) this.auth.validate(credential);
          return this.fetchImpl(destinationUrl(p, protocol), {
          method: "POST",
          headers,
          body: encodedRequest,
          redirect: "error",
          signal: combined,
          });
        }), combined);
        if (
          response.status !== 401 ||
          p.credential.kind !== "native-oauth" ||
          request.refreshes.has(t.profile)
        )
          break;
        request.refreshes.add(t.profile);
        await readBoundedBody(response.body, 64 * 1024, combined);
        if (action) {
          combined.throwIfAborted();
          validateAction();
        }
        const refreshed = await this.auth.refresh(t.profile, combined, credential);
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
    const limitContext: LimitContext = { provider: p.provider, product: p.product, protocol, profile: t.profile, model: t.model,
      ingress, configuredCredentialKind: p.credential.kind === "native-oauth" ? "native-oauth" : p.product === "kimi-code" ? "coding-plan-key" : "api-key",
      ...(request.scopeHash ? { scopeHash: request.scopeHash } : {}),
      ...(p.region ? { region: p.region } : {}),
      ...(request.route ? { route: request.route } : {}), ...(request.attempt !== undefined ? { attempt: request.attempt } : {}) };
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
      logProviderFailure(this.logger, "http_response", failure.kind, response.status,
        p.product === "kimi-code" && response.status === 400 ? providerErrorHints(body) : undefined);
      throw new AttemptFailure(failure);
    }
    const stageSnapshots = (final: Item) => {
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
              (item["type"] === "function_call" ||
                exec && item["type"] === "custom_tool_call" && item["name"] === "exec") &&
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
      (final, calls) => {
        if (!exec) { stageSnapshots(final); return; }
        if (disposed || completion || !calls) throw new RoutingError("invalid_codec_publication", 500);
        // The validator clears its calls array at EOF. Own an array copy and a
        // separate reservation before retaining either observed representation.
        const observed = { final, calls: [...calls] };
        const lease = exec.pending.retain(observed);
        completion = observed; completionLease = lease;
      },
      this.logger,
      limitContext,
      exec,
    );
    let converted: AsyncIterable<ClientEvent>;
    if (codec) {
      converted = this.orderedMessages(response, p, t.model, combined, controller, limitContext, () => { orderedReady = true; },
        orderedPending!, orderedLeases, object(request.body["thinking"])?.["display"] === "omitted",
        (rawOutput, assistant) => ordered!.stageOutput(rawOutput, assistant));
    } else if (protocol === ingress) converted = identifyProviderEvents(raw, protocol, exec?.pending);
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
      ...(codec ? { atomicMessages: true as const } : {}),
      ...(orderedPending ? { atomicPending: orderedPending } : {}),
      ...(exec ? { orderedResponsesSuffix: {
        pending: exec.pending,
        beforePublication: (): undefined => {
          if (disposed || publicationReady || !completion || !transaction)
            throw new RoutingError("invalid_codec_publication", 500);
          try {
            stageSnapshots(completion.final);
            transaction.stageValidatedCalls(completion.calls);
            publicationReady = true;
          } finally { clearCompletion(); }
          return undefined;
        },
      } } : {}),
      commit: () => {
        if (action && !codec) {
          combined.throwIfAborted();
          validateAction();
        }
        if (codec) {
          if (!orderedReady || disposed) throw new RoutingError("invalid_codec_publication", 500);
          combined.throwIfAborted();
          this.auth.validate(credential);
          validateAction();
          if (ownerKey(p, t, protocol, credential.generation, codec) !== owner)
            throw new RoutingError("credential_owner_changed", 409);
          combined.throwIfAborted();
        }
        if (exec && (!publicationReady || disposed)) throw new RoutingError("invalid_codec_publication", 500);
        stage.commit();
      },
      cancel: async () => {
        try {
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
        } finally { dispose(); }
      },
    };
    } catch (error) { dispose(); throw error; }
  }
  private async *orderedMessages(
    response: Response, profile: AccessProfile, model: string, signal: AbortSignal, controller: AbortController,
    limitContext: LimitContext,
    onValidated: () => void,
    pending: KimiExecPending, leases: OrderedLeases, omittedDisplay: boolean,
    onOutput: (rawOutput: readonly Item[], assistant: Item) => void,
  ): AsyncGenerator<ClientEvent> {
    try {
      const frames = await renderValidatedKimiResponses(response, profile, signal, controller, this.clock, undefined,
        { logger: this.logger, limitContext }, { pending, leases, omittedDisplay, onOutput });
      for (const frame of frames) {
        signal.throwIfAborted();
        const data = frame.split("\n").find(line => line.startsWith("data: "))!;
        leases.push(pending.reserve(Buffer.byteLength(frame) + 1));
        const payload = JSON.parse(data.slice(6)) as Item;
        if (payload["type"] === "message_start" && object(payload["message"])?.["model"] !== model)
          throw new RoutingError("provider_model_mismatch", 502);
        yield { protocol: "messages", payload };
      }
      signal.throwIfAborted();
      onValidated();
    } catch (error) {
      if (error instanceof KimiResponsesBridgeError)
        throw new RoutingError(`kimi_ordered_response_${error.code}`, 502);
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
