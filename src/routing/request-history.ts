import { createHash } from "node:crypto";
import { inputItems } from "../codex-body.js";
import type { ContinuationStore } from "./continuation-store.js";
import {
  RoutingError,
  type ActionContext,
  type Item,
  type OriginatingClient,
  type WireProtocol,
} from "./routing-types.js";

const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");

/** Resolves scoped continuation history without mutating caller-owned requests. */
export class RequestHistory {
  constructor(private readonly continuations: ContinuationStore) {}

  resolve(
    body: Item,
    client: OriginatingClient,
    route: string,
    protocol: WireProtocol,
    context?: ActionContext,
  ): { conversation: string; full: Item; priorOwner?: string } {
    const previous = body["previous_response_id"];
    const requestedConversation = context
      ? this.conversationKey(body, client, route, context)
      : undefined;
    if (previous === undefined || previous === null)
      return {
        conversation:
          requestedConversation ?? this.conversationKey(body, client, route),
        full: structuredClone(body),
      };
    if (typeof previous !== "string")
      throw new RoutingError("invalid_continuation_id");
    const snapshot = this.continuations.get(
      previous,
      requestedConversation,
      route,
      protocol,
    );
    const incoming = structuredClone(body);
    const full: Item = {
      ...snapshot.request,
      ...incoming,
      input: [
        ...inputItems(snapshot.request["input"]),
        ...snapshot.output,
        ...inputItems(incoming["input"]),
      ],
    };
    delete full["previous_response_id"];
    return {
      conversation: snapshot.conversation,
      full,
      ...(snapshot.owner === "warmup" ? {} : { priorOwner: snapshot.owner }),
    };
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
}
