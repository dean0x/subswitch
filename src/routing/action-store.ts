import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { scheduleRoutingTimer, systemClock, type RoutingClock } from "./clock.js";
import {
  RoutingError,
  type ActionAffinity,
  type ActionContext,
  type OriginatingClient,
} from "./routing-types.js";

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // Only ESRCH proves owner death; permission and probe errors do not.
    return !(error instanceof Error && "code" in error && error.code === "ESRCH");
  }
}

interface Action {
  ownerPid?: number;
  context: ActionContext;
  phase: ActionAffinity["phase"];
  requests: Map<AbortSignal, { controller: AbortController; agentId?: string }>;
  transports: Set<() => void>;
  affinities: Map<string, ActionAffinity>;
}
/** Live owners keep their actions; only confirmed dead owners lose admitted work. */
export class ActionStore {
  readonly capability = randomBytes(32).toString("hex");
  private readonly actions = new Map<string, Action>();
  private affinityCount = 0;
  private cancelOwnerCheck: (() => void) | undefined;
  constructor(
    private readonly clock: RoutingClock = systemClock,
    private readonly isOwnerAlive: (pid: number) => boolean = isProcessAlive,
  ) {}
  private watchOwners(): void {
    if (this.cancelOwnerCheck) return;
    this.cancelOwnerCheck = scheduleRoutingTimer(
      this.clock,
      () => {
        this.cancelOwnerCheck = undefined;
        this.reclaimOwners();
        for (const action of this.actions.values()) {
          if (action.ownerPid !== undefined) {
            this.watchOwners();
            break;
          }
        }
      },
      1000,
    );
  }
  private reclaimOwners(): void {
    for (const [id, action] of this.actions) {
      if (action.ownerPid === undefined || this.isOwnerAlive(action.ownerPid))
        continue;
      this.cancel(id);
      // A dead owner cannot resume. Release capacity even if an aborted request has not settled.
      this.remove(id, action);
    }
  }
  authorized(value: string | undefined): boolean {
    return (
      !!value &&
      /^[a-f0-9]{64}$/.test(value) &&
      timingSafeEqual(Buffer.from(value), Buffer.from(this.capability))
    );
  }
  create(
    client: OriginatingClient,
    conversationId: string,
    namespace = "explicit",
    ownerPid?: number,
  ): { id: string; ingressPrefix: string } {
    if (
      ownerPid !== undefined &&
      (!Number.isSafeInteger(ownerPid) || ownerPid < 1 || ownerPid > 2147483647)
    )
      throw new RoutingError("invalid_action_context");
    if (this.actions.size >= 4096) this.reclaimOwners();
    if (this.actions.size >= 4096)
      throw new RoutingError("action_store_full", 503);
    if (
      !conversationId ||
      conversationId.length > 256 ||
      namespace.length > 128
    )
      throw new RoutingError("invalid_action_context");
    const id = randomUUID();
    this.actions.set(id, {
      ...(ownerPid !== undefined ? { ownerPid } : {}),
      context: {
        client,
        conversationId,
        namespace,
        actionId: id,
        agentId: "root",
      },
      phase: "active",
      requests: new Map(),
      transports: new Set(),
      affinities: new Map(),
    });
    if (ownerPid !== undefined) this.watchOwners();
    return { id, ingressPrefix: `/__subswitch/action/${id}/ingress` };
  }
  context(id: string, client: OriginatingClient): ActionContext {
    const action = this.actions.get(id);
    if (!action || action.context.client !== client)
      throw new RoutingError("action_state_lost", 409);
    if (action.phase !== "active")
      throw new RoutingError("action_admission_closed", 409);
    return { ...action.context };
  }
  /** A request receipt survives completion, but never cancellation or release. */
  validateContext(
    context: Readonly<ActionContext>,
    client: OriginatingClient,
    admissionSignal?: AbortSignal,
  ): void {
    const action = this.actions.get(context.actionId);
    if (!action || action.context.client !== client)
      throw new RoutingError("action_state_lost", 409);
    const admission = admissionSignal
      ? action.requests.get(admissionSignal)
      : undefined;
    if (admissionSignal) {
      if (!admission || admissionSignal.aborted ||
        (action.phase !== "active" && action.phase !== "closing"))
        throw new RoutingError("action_state_lost", 409);
    } else if (action.phase !== "active")
      throw new RoutingError("action_admission_closed", 409);
    const active = action.context;
    if (context.client !== client || active.namespace !== context.namespace ||
      active.conversationId !== context.conversationId || active.parentActionId !== context.parentActionId ||
      !(context.agentId === active.agentId || /^[a-f0-9]{64}$/.test(context.agentId)) ||
      (admission?.agentId !== undefined && admission.agentId !== context.agentId))
      throw new RoutingError("action_state_lost", 409);
    // HTTP admission precedes the body containing thread identity. Bind that
    // identity at the first validated dispatch; this receipt cannot switch agents.
    if (admission) admission.agentId = context.agentId;
  }
  affinity(context: ActionContext, route: string): ActionAffinity {
    if (this.affinityCount >= 4096) this.reclaimOwners();
    const a = this.actions.get(context.actionId);
    if (!a) throw new RoutingError("action_state_lost", 409);
    const key = JSON.stringify([context.agentId, route]);
    let affinity = a.affinities.get(key);
    if (!affinity) {
      if (this.affinityCount >= 4096)
        throw new RoutingError("affinity_store_full", 503);
      let inherited: ActionAffinity | undefined;
      for (const candidate of a.affinities.values()) {
        if (
          candidate.logicalRoute === route &&
          candidate.selectedTarget &&
          (!inherited || candidate.chainIndex > inherited.chainIndex)
        )
          inherited = candidate;
      }
      affinity = {
        context,
        logicalRoute: route,
        chainIndex: inherited?.chainIndex ?? 0,
        phase: "active",
        ...(inherited?.selectedTarget
          ? { selectedTarget: inherited.selectedTarget }
          : {}),
      };
      if (inherited?.selectedOwner)
        affinity.selectedOwner = inherited.selectedOwner;
      a.affinities.set(key, affinity);
      this.affinityCount++;
    }
    return affinity;
  }
  admit(context: ActionContext, controller: AbortController): () => void {
    this.context(context.actionId, context.client);
    const action = this.actions.get(context.actionId)!;
    if (action.requests.size >= 16)
      throw new RoutingError("action_request_limit", 503);
    action.requests.set(controller.signal, { controller });
    return () => {
      if (!action.requests.delete(controller.signal)) return;
      this.finalize(context.actionId, action);
    };
  }
  /** Idle transports do not keep an invocation active; admitted requests do. */
  attachTransport(context: ActionContext, close: () => void): () => void {
    this.context(context.actionId, context.client);
    const action = this.actions.get(context.actionId)!;
    if (action.transports.size >= 16)
      throw new RoutingError("action_transport_limit", 503);
    action.transports.add(close);
    return () => {
      action.transports.delete(close);
    };
  }
  complete(id: string): void {
    const a = this.actions.get(id);
    if (!a) throw new RoutingError("action_state_lost", 409);
    a.phase = "closing";
    this.finalize(id, a);
  }
  cancel(id: string): void {
    const a = this.actions.get(id);
    if (!a) throw new RoutingError("action_state_lost", 409);
    a.phase = "cancelled";
    for (const { controller } of a.requests.values())
      controller.abort(new RoutingError("action_cancelled", 499));
    for (const close of a.transports) close();
    a.transports.clear();
    this.finalize(id, a);
  }
  private finalize(id: string, action: Action): void {
    if (action.phase !== "active" && !action.requests.size) this.remove(id, action);
  }
  private remove(id: string, action: Action): void {
    if (this.actions.get(id) !== action) return;
    for (const close of action.transports) close();
    action.transports.clear();
    this.actions.delete(id);
    this.affinityCount -= action.affinities.size;
  }
  close(): void {
    this.cancelOwnerCheck?.();
    this.cancelOwnerCheck = undefined;
    for (const id of this.actions.keys()) this.cancel(id);
  }
}
