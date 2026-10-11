import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import {
  RoutingError,
  type ActionAffinity,
  type ActionContext,
  type OriginatingClient,
} from "./routing-types.js";

interface Action {
  context: ActionContext;
  phase: ActionAffinity["phase"];
  requests: Set<AbortController>;
  affinities: Map<string, ActionAffinity>;
}
/** No active entry eviction; exhaustion is truthful admission failure. */
export class ActionStore {
  readonly capability = randomBytes(32).toString("hex");
  private readonly actions = new Map<string, Action>();
  private affinityCount = 0;
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
  ): { id: string; ingressPrefix: string } {
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
      context: {
        client,
        conversationId,
        namespace,
        actionId: id,
        agentId: "root",
      },
      phase: "active",
      requests: new Set(),
      affinities: new Map(),
    });
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
  affinity(context: ActionContext, route: string): ActionAffinity {
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
    action.requests.add(controller);
    return () => {
      action.requests.delete(controller);
      this.finalize(context.actionId, action);
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
    for (const c of a.requests)
      c.abort(new RoutingError("action_cancelled", 499));
    this.finalize(id, a);
  }
  private finalize(id: string, action: Action): void {
    if (action.phase !== "active" && !action.requests.size) {
      this.actions.delete(id);
      this.affinityCount -= action.affinities.size;
    }
  }
  close(): void {
    for (const id of this.actions.keys()) this.cancel(id);
  }
}
