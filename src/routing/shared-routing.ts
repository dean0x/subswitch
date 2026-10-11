import { createHash, randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { deliverResponse } from "./response-delivery.js";
import { writeRoutedHttp } from "./http-ingress.js";
import { ActionIngress } from "./action-ingress.js";
import { ActionStore } from "./action-store.js";
import { ContinuationStore } from "./continuation-store.js";
import { QuotaStore, scopeKey } from "./quota-store.js";
import {
  systemClock,
  scheduleRoutingTimer,
  type RoutingClock,
} from "./clock.js";
import { ProfileAuth, abortable } from "./profile-auth.js";
import {
  RoutedAttempts,
  AttemptFailure,
  type RoutedPrepared,
} from "./routed-attempt.js";
import { routeChain } from "./routing-config.js";
import { object } from "../plain-object.js";
import { inputItems } from "../codex-body.js";
import {
  allowanceScope,
  RoutingError,
  type ActionContext,
  type AllowanceScope,
  type ClassifiedFailure,
  type Item,
  type OriginatingClient,
  type WireProtocol,
} from "./routing-types.js";
import type { Config } from "../config.js";
import type { Logger } from "../logger.js";
import { decodePortableHistory } from "./portable-history.js";
import { UsageCoordinator, type UsageDriver } from "./usage-coordinator.js";

const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");

/** One selection, quota and continuation owner for both originating protocols. */
export class SharedRouting {
  readonly actions = new ActionStore();
  readonly quota: QuotaStore;
  readonly continuations = new ContinuationStore();
  readonly attempts: RoutedAttempts;
  readonly usage: UsageCoordinator;
  private readonly controllers = new Set<AbortController>();
  private readonly selections = new Map<string, Promise<void>>();
  constructor(
    readonly config: Config,
    readonly logger: Logger,
    readonly clock: RoutingClock = systemClock,
    fetchImpl: typeof fetch = fetch,
    env: NodeJS.ProcessEnv = process.env,
    usageDriver?: UsageDriver,
  ) {
    this.quota = new QuotaStore(clock);
    this.usage = new UsageCoordinator(this.quota, usageDriver);
    this.attempts = new RoutedAttempts(
      new ProfileAuth(config.accessProfiles ?? {}, logger, env),
      logger,
      fetchImpl,
      clock,
      config.providers.codex.userAgent,
    );
  }
  close(): void {
    this.actions.close();
    this.usage.close();
    for (const c of this.controllers) c.abort();
  }
  match(body: Item, client: OriginatingClient): string | undefined {
    const name =
      body["model"] ??
      (typeof body["previous_response_id"] === "string"
        ? this.continuations.route(body["previous_response_id"])
        : undefined);
    return typeof name === "string" &&
      this.config.routes?.[name]?.clients.includes(client)
      ? name
      : undefined;
  }
  private readonly actionIngress = new ActionIngress(this.actions);
  stripPrefix(req: IncomingMessage): void {
    this.actionIngress.stripPrefix(req);
  }
  context(
    req: IncomingMessage,
    client: OriginatingClient,
    body: Item,
  ): ActionContext | undefined {
    return this.actionIngress.context(req, client, body);
  }
  control(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    return this.actionIngress.control(req, res);
  }
  async *events(
    body: Item,
    client: OriginatingClient,
    routeName: string,
    signal: AbortSignal,
    context?: ActionContext,
  ): AsyncGenerator<Item> {
    const policy = this.config.routes?.[routeName];
    if (!policy) throw new RoutingError("unknown_route");
    const protocol: WireProtocol =
      client === "codex" ? "responses" : "messages";
    if (body["generate"] === false) {
      // No action, affinity, credential resolution or quota observation for a warmup.
      if (protocol === "responses") {
        const conversation = this.conversationKey(
          body,
          client,
          routeName,
          context,
        );
        const id = this.continuations.put({
          conversation,
          route: routeName,
          request: body,
          output: [],
          owner: "warmup",
          protocol,
        });
        const response = {
          id,
          object: "response",
          model: routeName,
          status: "completed",
          output: [],
        };
        yield {
          type: "response.created",
          response: { ...response, status: "in_progress" },
          sequence_number: 0,
        };
        yield { type: "response.completed", response, sequence_number: 1 };
      }
      return;
    }
    const chain = routeChain(policy);
    if (!this.attempts.auth.has(chain[0]!.profile))
      throw new RoutingError("profile_credentials_missing", 503);
    if (chain.length > 1 && !context)
      throw new RoutingError("action_identity_required", 409);
    const controller = new AbortController(),
      deadline = this.clock.monotonic() + 600000;
    const timeout = () =>
      controller.abort(new RoutingError("request_timeout", 504));
    const cancelTotal = scheduleRoutingTimer(this.clock, timeout, 600000);
    const combined = AbortSignal.any([signal, controller.signal]);
    this.controllers.add(controller);
    let releaseAction: () => void = () => undefined;
    let releaseSelection: (() => void) | undefined;
    try {
      if (context) releaseAction = this.actions.admit(context, controller);
      if (context) {
        const key = JSON.stringify([
          context.actionId,
          context.agentId,
          routeName,
        ]);
        const previous = this.selections.get(key);
        let unlock!: () => void;
        const gate = new Promise<void>((resolve) => {
          unlock = resolve;
        });
        const current = (previous ?? Promise.resolve()).then(() => gate);
        this.selections.set(key, current);
        releaseSelection = () => {
          unlock();
          if (this.selections.get(key) === current) this.selections.delete(key);
        };
        if (previous) await abortable(previous, combined);
      }
      const conversation = this.conversationKey(
        body,
        client,
        routeName,
        context,
      );
      const affinity = context
        ? this.actions.affinity(context, routeName)
        : undefined;
      const full: Item = structuredClone(body);
      let priorOwner: string | undefined;
      const previous = full["previous_response_id"];
      if (previous !== undefined && previous !== null) {
        if (typeof previous !== "string")
          throw new RoutingError("invalid_continuation_id");
        const snapshot = this.continuations.get(
          previous,
          conversation,
          routeName,
        );
        priorOwner = snapshot.owner === "warmup" ? undefined : snapshot.owner;
        Object.assign(full, snapshot.request, body, {
          input: [
            ...inputItems(snapshot.request["input"]),
            ...snapshot.output,
            ...inputItems(body["input"]),
          ],
        });
        delete full["previous_response_id"];
      }
      if (Buffer.byteLength(JSON.stringify(full)) > 32 * 1024 * 1024)
        throw new RoutingError("reconstructed_request_too_large", 413);
      const transcript = decodePortableHistory(full, protocol);
      const refreshes = new Set<string>();
      let failure: ClassifiedFailure | undefined,
        committed = false;
      for (
        let index = affinity?.chainIndex ?? 0;
        index < chain.length;
        index++
      ) {
        if (this.clock.monotonic() >= deadline) timeout();
        combined.throwIfAborted();
        const target = chain[index]!,
          profile = this.config.accessProfiles?.[target.profile];
        if (!profile) throw new RoutingError("unknown_profile");
        if (!this.attempts.auth.has(target.profile)) {
          if (index === 0 && !failure)
            throw new RoutingError("profile_credentials_missing", 503);
          this.diagnostic(
            routeName,
            target.profile,
            index,
            "credentials_missing",
            allowanceScope(profile),
          );
          continue;
        }
        const credential = await this.attempts.auth.get(
          target.profile,
          combined,
        );
        const scope = this.attempts.auth.scope(credential);
        if (
          !affinity?.selectedTarget &&
          this.quota.readiness(scope) !== "available"
        )
          await abortable(this.usage.refresh(scope), combined);
        const pinned =
          !!affinity?.selectedTarget &&
          index === affinity.chainIndex &&
          affinity.selectedTarget.profile === target.profile &&
          affinity.selectedTarget.model === target.model &&
          affinity.selectedTarget.effort === target.effort;
        const requestedEffort =
          object(full["reasoning"])?.["effort"] ??
          object(full["output_config"])?.["effort"];
        if (requestedEffort !== undefined && requestedEffort !== target.effort)
          this.logger.log("info", "route_effort_applied", {
            route: routeName,
            effort: target.effort,
            errorCode: "client_effort_overridden",
          });
        const reservation = Symbol("route-attempt");
        if (!pinned && !this.quota.reserve(scope, reservation)) {
          this.diagnostic(
            routeName,
            target.profile,
            index,
            "quota_blocked",
            scope,
          );
          continue;
        }
        let prepared: RoutedPrepared | undefined;
        const localId = `resp_subswitch_route_${randomUUID()}`;
        this.diagnostic(
          routeName,
          target.profile,
          index,
          "attempt_started",
          scope,
        );
        try {
          prepared = await this.attempts.prepare({
            profile,
            target,
            body: full,
            transcript,
            credential,
            protocol,
            conversation,
            signal: combined,
            refreshes,
            ...(priorOwner ? { priorOwner } : {}),
            ...(pinned && affinity?.selectedOwner
              ? { expectedOwner: affinity.selectedOwner }
              : {}),
          });
          const ready = prepared;
          yield* deliverResponse(ready, {
            protocol,
            responseId: localId,
            model: target.model,
            streaming: body["stream"] !== false,
            signal: combined,
            checkDeadline: () => {
              if (this.clock.monotonic() >= deadline) timeout();
            },
            onCommit: () => {
              if (affinity)
                Object.assign(affinity, {
                  selectedTarget: target,
                  selectedOwner: ready.owner,
                  chainIndex: index,
                });
              committed = true;
              this.diagnostic(
                routeName,
                target.profile,
                index,
                "committed",
                scope,
              );
            },
            onTerminal: (response) => {
              let publishContinuation: (() => void) | undefined;
              if (
                protocol === "responses" &&
                response &&
                Array.isArray(response["output"])
              ) {
                publishContinuation = this.continuations.preparePut(
                  {
                    conversation,
                    route: routeName,
                    request: full,
                    output: response["output"] as Item[],
                    owner: ready.owner,
                    protocol,
                  },
                  localId,
                );
              }
              // These operations are synchronous: budgets are checked before either store is published.
              ready.commit();
              publishContinuation?.();
              this.quota.success(scope, reservation);
            },
          });
          return;
        } catch (error) {
          if (
            !combined.aborted &&
            !(
              error instanceof AttemptFailure &&
              ["quota", "rate_limit"].includes(error.failure.kind)
            )
          )
            this.quota.recoveryFailure(
              scope,
              error instanceof AttemptFailure
                ? error.failure.retryAt
                : undefined,
              reservation,
            );
          this.quota.release(scope, reservation);
          if (combined.aborted) {
            if (affinity) affinity.phase = "interrupted";
            throw combined.reason instanceof RoutingError
              ? combined.reason
              : new RoutingError("request_cancelled", 499);
          }
          if (error instanceof AttemptFailure) {
            failure = { ...error.failure, scope, responseCommitted: committed };
            this.quota.fail(failure, reservation);
            this.diagnostic(
              routeName,
              target.profile,
              index,
              committed ? "committed_failure" : failure.kind,
              scope,
            );
            if (
              committed ||
              (!["quota", "rate_limit"].includes(failure.kind) &&
                !policy.transientTriggers.includes(
                  failure.kind as "overload" | "transport",
                ))
            ) {
              if (affinity) affinity.phase = "interrupted";
              throw error;
            }
            if (affinity) affinity.chainIndex = index + 1;
            continue;
          }
          if (
            error instanceof RoutingError &&
            ["continuity_unavailable", "unsupported_routed_content"].includes(
              error.code,
            ) &&
            index > 0 &&
            !committed
          ) {
            this.diagnostic(
              routeName,
              target.profile,
              index,
              "incompatible_candidate",
              scope,
            );
            continue;
          }
          throw error;
        } finally {
          await prepared?.cancel();
        }
      }
      if (failure) throw new AttemptFailure(failure);
      throw new RoutingError("route_targets_exhausted", 503);
    } finally {
      cancelTotal();
      releaseSelection?.();
      releaseAction();
      this.controllers.delete(controller);
    }
  }
  private conversationKey(
    body: Item,
    client: OriginatingClient,
    route: string,
    context?: ActionContext,
  ): string {
    const firstInput = Array.isArray(body["messages"])
      ? body["messages"][0]
      : inputItems(body["input"])[0];
    return hash(
      JSON.stringify([
        client,
        context?.namespace ?? "single-target",
        context?.conversationId ?? hash(JSON.stringify(firstInput) ?? ""),
        context?.agentId ?? "root",
        route,
      ]),
    );
  }
  private diagnostic(
    route: string,
    profile: string,
    order: number,
    code: string,
    scope: AllowanceScope,
  ): void {
    const p = this.config.accessProfiles?.[profile];
    const windows = this.quota.observations(scope);
    const window = windows.at(-1);
    const readiness = this.quota.readiness(scope);
    this.logger.log("info", "route_attempt", {
      route,
      targetProfile: profile,
      attemptOrder: order,
      ...(p ? { product: p.product } : {}),
      model: routeChain(this.config.routes![route]!)[order]?.model ?? "",
      errorCode: code,
      sessionKey: scopeKey(scope).slice(0, 8),
      commitState: code.startsWith("committed") ? "committed" : "uncommitted",
      retryEligible: readiness === "eligible-for-retry",
      evidence: window?.source === "inference" ? "documented" : "unknown",
      ...(window
        ? {
            quotaWindow: window.id,
            observationAgeMs: Math.max(0, this.clock.now() - window.observedAt),
          }
        : {}),
    });
  }
  http(
    req: IncomingMessage,
    res: ServerResponse,
    body: Item,
    client: OriginatingClient,
    route: string,
  ): Promise<void> {
    return writeRoutedHttp(
      this,
      this.logger,
      this.clock,
      req,
      res,
      body,
      client,
      route,
    );
  }
}
