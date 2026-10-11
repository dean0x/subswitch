import { reverseRequest } from "../claude-adapter.js";
import { translateRequest } from "../codex-request.js";
import { AnthropicRequestSchema } from "../anthropic-wire-types.js";
import { CLAUDE_SUBSCRIPTION_PREAMBLE } from "../claude-contract.js";
import { ClaudeCache } from "../claude-cache.js";
import { ReverseState } from "../claude-state.js";
import { ReasoningCache } from "../reasoning-cache.js";
import { object } from "../plain-object.js";
import { validateTargetCapabilities } from "./target-capabilities.js";
import {
  renderResponsesHistory,
  type PortableTranscript,
} from "./portable-history.js";
import {
  RoutingError,
  type AccessProfile,
  type Item,
  type RouteTarget,
  type WireProtocol,
} from "./routing-types.js";

interface RequestAdaptation {
  profile: AccessProfile;
  target: RouteTarget;
  body: Item;
  ingress: WireProtocol;
  protocol: WireProtocol;
  transcript: PortableTranscript;
  stage: ClaudeCache;
  state: ReverseState;
  owner: string;
  conversation: string;
  sessionId: string;
  priorOwner?: string | undefined;
}

/** Product parameters and ingress codecs; no auth, network, output, or route selection. */
export function adaptRequest(request: RequestAdaptation): {
  outbound: Item;
  reverse?: ReturnType<typeof reverseRequest> | undefined;
} {
  const {
    profile: p,
    target: t,
    ingress,
    protocol,
    transcript,
    stage,
    state,
    owner,
    conversation,
    sessionId,
    priorOwner,
  } = request;
  validateTargetCapabilities(
    p,
    t,
    request.body,
    ingress,
    protocol,
    transcript.tools.length > 0,
  );
  let body: Item = {
    ...(p.provider === "kimi" && ingress === "responses"
      ? renderResponsesHistory(transcript)
      : request.body),
    model: t.model,
  };
  if (protocol === "messages" && ingress === "messages")
    body = normalizeMessagesInstructions(body);
  if (ingress === "messages" && Array.isArray(body["messages"])) {
    for (const message of body["messages"]) {
      const m = object(message);
      if (!Array.isArray(m?.["content"])) continue;
      for (const block of m["content"]) {
        const b = object(block);
        if (b?.["type"] === "thinking" || b?.["type"] === "redacted_thinking") {
          const signature = b[b["type"] === "thinking" ? "signature" : "data"];
          const recorded =
            typeof signature === "string"
              ? stage.get(
                  "snapshot",
                  `signature:${owner}:${conversation}:${signature}`,
                )?.input[0]
              : undefined;
          if (
            !recorded ||
            b["type"] !== recorded["type"] ||
            (b["type"] === "thinking"
              ? typeof b["thinking"] !== "string" ||
                b["thinking"] !== recorded["thinking"] ||
                b["signature"] !== recorded["signature"] ||
                b["data"] !== undefined
              : b["data"] !== recorded["data"] ||
                b["signature"] !== undefined ||
                b["thinking"] !== undefined)
          )
            throw new RoutingError("foreign_opaque_state", 409);
        }
      }
    }
  }
  const switched = priorOwner !== undefined && priorOwner !== owner;
  // Target-owned opaque history is separate from portable text/tools. Cross-target reasoning
  // portability is disabled pending exact provider evidence.
  if (switched && (transcript.hasOpaqueReasoning || transcript.hasThinking))
    throw new RoutingError("continuity_unavailable", 409);
  if (
    protocol === "responses" &&
    ingress === "responses" &&
    transcript.hasOpaqueReasoning
  ) {
    const input = Array.isArray(body["input"]) ? body["input"] : [];
    for (const item of input) {
      const entry = object(item);
      if (
        entry?.["type"] === "reasoning" &&
        entry["encrypted_content"] &&
        !stage.get(
          "snapshot",
          `opaque:${owner}:${conversation}:${String(entry["encrypted_content"])}`,
        )
      )
        throw new RoutingError("foreign_opaque_state", 409);
    }
  }
  let outbound: Item = body;
  let reverse: ReturnType<typeof reverseRequest> | undefined;
  if (protocol === "messages" && ingress === "responses") {
    reverse = reverseRequest(
      { ...body, reasoning: { effort: t.effort } },
      p.product === "claude-code"
        ? [{ type: "text", text: CLAUDE_SUBSCRIPTION_PREAMBLE }]
        : [],
      state,
    );
    outbound = reverse.body;
  } else if (protocol === "responses" && ingress === "messages") {
    const parsed = AnthropicRequestSchema.safeParse(body);
    if (!parsed.success) throw new RoutingError("invalid_routed_messages");
    // Unknown/multimodal content is refused before a legacy translator could drop it.
    class ScopedReasoning extends ReasoningCache {
      constructor() {
        super(1, 1);
      }
      override get(id: string): readonly unknown[] | undefined {
        return stage.get("snapshot", `reasoning:${owner}:${conversation}:${id}`)
          ?.input;
      }
    }
    const translated = translateRequest(
      parsed.data,
      new ScopedReasoning(),
      conversation,
    );
    if (
      !translated.ok ||
      translated.value.warnings.some((w) => w !== "unsupported_effort_dropped")
    )
      throw new RoutingError("continuity_unavailable", 409);
    outbound = translated.value.body;
    if (p.product === "openai-api" && body["max_tokens"] !== undefined)
      outbound = { ...outbound, max_output_tokens: body["max_tokens"] };
    if (transcript?.toolErrors.size && Array.isArray(outbound["input"])) {
      outbound["input"] = outbound["input"].map((value) => {
        const entry = object(value);
        return entry &&
          entry["type"] === "function_call_output" &&
          transcript!.toolErrors.has(String(entry["call_id"]))
          ? {
              ...entry,
              output: `[Tool execution failed]\n${String(entry["output"])}`,
            }
          : value;
      });
    }
  }
  outbound = { ...outbound, model: t.model, stream: true };
  if (protocol === "responses") {
    delete outbound["previous_response_id"];
    delete outbound["conversation"];
    delete outbound["background"];
    delete outbound["generate"];
    delete outbound["client_metadata"];
    outbound["store"] = false;
    outbound["reasoning"] = { effort: t.effort };
    if (p.product === "chatgpt-codex") outbound["prompt_cache_key"] = sessionId;
    if (p.provider === "kimi") delete outbound["include"];
  } else {
    outbound["output_config"] = {
      ...object(outbound["output_config"]),
      effort: t.effort,
    };
    if (p.provider === "kimi") {
      delete outbound["cache_control"];
      delete outbound["temperature"];
    }
  }
  return { outbound, reverse };
}

/** Claude's native child harness uses leading system-role messages. Messages APIs use `system`. */
function normalizeMessagesInstructions(body: Item): Item {
  const messages = body["messages"] as Item[];
  const system: Item[] =
    typeof body["system"] === "string"
      ? [{ type: "text", text: body["system"] }]
      : Array.isArray(body["system"])
        ? ([...body["system"]] as Item[])
        : [];
  const history: Item[] = [];
  let hasSystemMessages = false;
  for (const message of messages) {
    if (message["role"] !== "system") {
      history.push(message);
      continue;
    }
    // Later instruction changes cannot be reordered into the initial preamble.
    if (history.length) throw new RoutingError("continuity_unavailable", 409);
    hasSystemMessages = true;
    system.push(
      ...(typeof message["content"] === "string"
        ? [{ type: "text", text: message["content"] }]
        : (message["content"] as Item[])),
    );
  }
  return hasSystemMessages ? { ...body, system, messages: history } : body;
}
