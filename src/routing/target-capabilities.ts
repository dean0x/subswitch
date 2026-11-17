import { claudeModel } from "../claude-models.js";
import { object } from "../plain-object.js";
import {
  RoutingError,
  type AccessProfile,
  type Item,
  type RouteTarget,
  type WireProtocol,
} from "./routing-types.js";

/** Only evidence-backed model/product limits belong here; unknown membership limits stay unknown. */
export function validateTargetCapabilities(
  profile: AccessProfile,
  target: RouteTarget,
  body: Item,
  ingress: WireProtocol,
  protocol: WireProtocol,
  hasTools: boolean,
): void {
  const maximum =
    body[ingress === "messages" ? "max_tokens" : "max_output_tokens"];
  if (
    maximum !== undefined &&
    (typeof maximum !== "number" ||
      !Number.isSafeInteger(maximum) ||
      maximum < 1)
  )
    throw new RoutingError("invalid_output_limit");
  const incompatible = () => {
    throw new RoutingError("target_capability_unavailable", 422);
  };
  if (protocol === "messages" && ingress === "responses") {
    const format = object(object(body["text"])?.["format"]);
    if (format && format["type"] !== "text") incompatible();
  }
  if (
    profile.product === "chatgpt-codex" &&
    ingress === "responses" &&
    maximum !== undefined
  )
    incompatible(); // The subscription backend rejects max_output_tokens; the API accepts it.
  if (profile.provider !== "claude") return;
  const capability = claudeModel(target.model);
  if (!capability) return;
  if (typeof maximum === "number" && maximum > capability.maxOutputTokens)
    incompatible();
  const choice = body["tool_choice"];
  const forced =
    ingress === "responses"
      ? choice === "required" ||
        ["function", "custom"].includes(String(object(choice)?.["type"]))
      : ["any", "tool"].includes(String(object(choice)?.["type"]));
  if (hasTools && forced && !capability.forcedToolChoice) incompatible();
  if (
    ingress === "messages" &&
    capability.thinkingAlwaysOn &&
    object(body["thinking"])?.["type"] === "disabled"
  )
    incompatible();
}
