import { createHash } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { ActionStore } from "./action-store.js";
import { object } from "../plain-object.js";
import { respondJson } from "../provider-transport.js";
import { toAnthropicErrorBody } from "../errors.js";
import {
  RoutingError,
  type ActionContext,
  type Item,
  type OriginatingClient,
} from "./routing-types.js";

/** Explicit lifecycle transport. Provider terminals never close native actions. */
export class ActionIngress {
  private readonly requests = new WeakMap<IncomingMessage, string>();
  constructor(private readonly store: ActionStore) {}
  stripPrefix(req: IncomingMessage): void {
    const match =
      /^\/__subswitch\/action\/([a-f0-9-]{36})\/ingress(\/.*)$/.exec(
        req.url ?? "",
      );
    if (!match) return;
    this.requests.set(req, match[1]!);
    req.url = match[2]!;
  }
  context(
    req: IncomingMessage,
    client: OriginatingClient,
    body: Item,
  ): ActionContext | undefined {
    const id = this.requests.get(req);
    if (!id) return undefined;
    const context = this.store.context(id, client);
    // A complete explicit invocation includes children. Branch state is isolated by
    // observed thread identity; unverified lifecycle metadata never creates an action.
    const thread = req.headers["thread-id"] ?? req.headers["session-id"];
    const metadata = object(body["client_metadata"]);
    const branch = metadata?.["thread_id"] ?? thread;
    if (typeof branch === "string" && branch && branch.length <= 256)
      context.agentId = createHash("sha256").update(branch).digest("hex");
    return context;
  }
  async control(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    const path = req.url?.split("?")[0] ?? "";
    if (!path.startsWith("/__subswitch/actions")) return false;
    const capability = req.headers["x-subswitch-capability"];
    if (
      !this.store.authorized(
        typeof capability === "string" ? capability : undefined,
      )
    ) {
      respondJson(
        res,
        403,
        toAnthropicErrorBody("permission_error", "action_control_forbidden"),
      );
      req.resume();
      return true;
    }
    try {
      if (req.method !== "POST")
        throw new RoutingError("action_method_not_allowed", 405);
      if (path === "/__subswitch/actions") {
        const parts: Buffer[] = [];
        let bytes = 0;
        for await (const part of req) {
          bytes += part.length;
          if (bytes > 4096)
            throw new RoutingError("action_request_too_large", 413);
          parts.push(part);
        }
        const body = object(JSON.parse(Buffer.concat(parts).toString("utf8")));
        if (
          !body ||
          !["claude-code", "codex"].includes(String(body["client"])) ||
          typeof body["conversationId"] !== "string"
        )
          throw new RoutingError("invalid_action_context");
        respondJson(
          res,
          201,
          JSON.stringify(
            this.store.create(
              body["client"] as OriginatingClient,
              body["conversationId"],
            ),
          ),
        );
      } else {
        const operation =
          /^\/__subswitch\/actions\/([a-f0-9-]{36})\/(complete|cancel)$/.exec(
            path,
          );
        if (!operation) throw new RoutingError("unknown_action_endpoint", 404);
        if (operation[2] === "complete") this.store.complete(operation[1]!);
        else this.store.cancel(operation[1]!);
        req.resume();
        respondJson(
          res,
          200,
          JSON.stringify({
            phase: operation[2] === "complete" ? "closing" : "cancelled",
          }),
        );
      }
    } catch (error) {
      const e =
        error instanceof RoutingError
          ? error
          : new RoutingError("invalid_action_request");
      respondJson(
        res,
        e.status,
        toAnthropicErrorBody("invalid_request_error", e.code),
      );
    }
    return true;
  }
}
