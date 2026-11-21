import { buildInstructions } from "./anthropic-parse.js";
import type { AnthropicMessage, AnthropicRequest } from "./anthropic-wire-types.js";
import type { GeminiErrorCode } from "./gemini-errors.js";
import { isPlainObject } from "./plain-object.js";
import type { ReasoningCache } from "./reasoning-cache.js";
import { err, ok, type Result } from "./result.js";

// [D4] Qualify the model field before use.
const UNQUALIFIED_MODEL = {};
// [D4] Qualify the generation settings before use.
const UNQUALIFIED_GENERATION_CONFIG = {};
// [D4] Qualify tool selection before use.
const UNQUALIFIED_TOOL_CONFIG = {};
// [D4] Qualify the session field before use.
const UNQUALIFIED_SESSION_ID = {};
// [D4] Qualify the request type before use.
const UNQUALIFIED_REQUEST_TYPE = {};
// [D4] Qualify the body user agent before use.
const UNQUALIFIED_USER_AGENT = {};
// [D4] Omit declarations until the tool schema keyword rule is known.
const UNQUALIFIED_TOOL_DECLARATIONS = {};
// [D4] Omit the budget until its mapping and location are known.
const UNQUALIFIED_THINKING_BUDGET = {};

const TOOL_ID_PREFIX = "toolu_subswitch_gemini_";

/** Keep the signature on the server. The client ID records only whether it is required. */
export const geminiClientToolId = (callId: string, requiresSignature: boolean): string =>
  `${TOOL_ID_PREFIX}${requiresSignature ? "s" : "u"}_${Buffer.from(callId).toString("base64url")}`;

/** Both codecs use the original Gemini call ID, not the ID sent to Claude Code. */
export const geminiSignatureKey = (conversationKey: string, callId: string): string =>
  JSON.stringify([conversationKey, callId]);

/** Store one such entry per signed call in a dedicated, strictly bounded ReasoningCache. */
export type GeminiSignatureEntry = readonly [signature: string];

export interface GeminiRequestOptions {
  readonly conversationKey?: string;
  readonly signatures: Pick<ReasoningCache, "get">;
}

export type GeminiRequestError = Extract<GeminiErrorCode, "signature_missing" | "image_unsupported" | "invalid_request">;
type RequestResult<T> = Result<T, GeminiRequestError>;
type Role = "user" | "model";
type Block = Readonly<Record<string, unknown>>;
type Text = { readonly text: string };
type Call = { readonly id: string; readonly name: string; readonly args: Block };
type CallPart = { readonly functionCall: Call; readonly thoughtSignature?: string };
type Part = Text | CallPart
  | { readonly functionResponse: { readonly id: string; readonly name: string; readonly response: { readonly output: string } } };
type Content = { readonly role: Role; readonly parts: readonly Part[] };

/** Partial frame. A handler must not send it until the deferred fields qualify. */
export interface GeminiRequestFrame {
  readonly request: {
    readonly contents: readonly Content[];
    readonly systemInstruction?: { readonly role: "user"; readonly parts: readonly Text[] };
  };
}

const invalid = err("invalid_request" as const);
const imageUnsupported = err("image_unsupported" as const);
const signatureMissing = err("signature_missing" as const);
const nonempty = (value: unknown): value is string => typeof value === "string" && value !== "";

const parseCallId = (id: string): RequestResult<{ readonly id: string; readonly requiresSignature: boolean }> => {
  if (!id.startsWith(TOOL_ID_PREFIX)) return ok({ id, requiresSignature: false });
  const tagged = id.slice(TOOL_ID_PREFIX.length);
  const tag = tagged.slice(0, 2);
  if (tag !== "s_" && tag !== "u_") return invalid;
  const requiresSignature = tag === "s_";
  const raw = Buffer.from(tagged.slice(2), "base64url").toString("utf8");
  if (raw === "" || geminiClientToolId(raw, requiresSignature) !== id) return invalid;
  return ok({ id: raw, requiresSignature });
};

const mapCall = (block: Block, options: GeminiRequestOptions): RequestResult<CallPart> => {
  const { id, name, input } = block;
  if (!nonempty(id) || !nonempty(name) || !isPlainObject(input)) return invalid;
  const call = parseCallId(id);
  if (!call.ok) return call;
  const functionCall = { id: call.value.id, name, args: input };
  if (!call.value.requiresSignature) return ok({ functionCall });
  if (options.conversationKey === undefined) return signatureMissing;
  const cached = options.signatures.get(geminiSignatureKey(options.conversationKey, functionCall.id));
  if (cached?.length !== 1 || !nonempty(cached[0])) return signatureMissing;
  return ok({ functionCall, thoughtSignature: cached[0] });
};

const isImage = (value: unknown): boolean => isPlainObject(value) && value["type"] === "image";
const hasImage = (content: AnthropicMessage["content"]): boolean => Array.isArray(content) && content.some((block) => {
  if (isImage(block)) return true;
  const nested = block["content"];
  return block["type"] === "tool_result" && Array.isArray(nested) && nested.some(isImage);
});

const toolOutput = (content: unknown): RequestResult<string> => {
  if (content === undefined) return ok("");
  if (typeof content === "string") return ok(content);
  if (!Array.isArray(content)) return invalid;
  const texts: string[] = [];
  for (const block of content as readonly unknown[]) {
    if (!isPlainObject(block)) return invalid;
    switch (block["type"]) {
      case "thinking": case "redacted_thinking": break;
      case "text":
        if (typeof block["text"] !== "string") return invalid;
        texts.push(block["text"]);
        break;
      default: return invalid;
    }
  }
  return ok(texts.join("\n"));
};

const mapResult = (block: Block, calls: ReadonlyMap<string, Call>): RequestResult<Part> => {
  const clientId = block["tool_use_id"];
  const call = nonempty(clientId) ? calls.get(clientId) : undefined;
  if (call === undefined) return invalid;
  const output = toolOutput(block["content"]);
  if (!output.ok) return output;
  return ok({ functionResponse: { id: call.id, name: call.name, response: { output: output.value } } });
};

const mapMessages = (messages: readonly AnthropicMessage[], options: GeminiRequestOptions): RequestResult<Content[]> => {
  const contents: Content[] = [];
  const calls = new Map<string, Call>();
  for (const { role, content } of messages) {
    if (role !== "assistant" && role !== "user") return invalid;
    const defaultRole = role === "assistant" ? "model" : "user";
    if (typeof content === "string") {
      contents.push({ role: defaultRole, parts: [{ text: content }] });
      continue;
    }
    // Keep each input turn separate. Split its parts only where the wire role changes.
    let turn: { role: Role; parts: Part[] } | undefined;
    const append = (partRole: Role, part: Part): void => {
      if (turn?.role !== partRole) {
        turn = { role: partRole, parts: [] };
        contents.push(turn);
      }
      turn.parts.push(part);
    };
    for (const block of content) {
      switch (block["type"]) {
        case "thinking": case "redacted_thinking": break;
        case "text":
          if (typeof block["text"] !== "string") return invalid;
          append(defaultRole, { text: block["text"] });
          break;
        case "tool_use": {
          const clientId = block["id"];
          if (role !== "assistant" || !nonempty(clientId) || calls.has(clientId)) return invalid;
          const part = mapCall(block, options);
          if (!part.ok) return part;
          calls.set(clientId, part.value.functionCall);
          append("model", part.value);
          break;
        }
        case "tool_result": {
          if (role !== "user") return invalid;
          const part = mapResult(block, calls);
          if (!part.ok) return part;
          append("model", part.value);
          break;
        }
        default: return invalid;
      }
    }
  }
  return ok(contents);
};

/** Input comes from the Anthropic parser under the buffered ingress byte cap. No I/O. */
export const buildGeminiRequest = (input: AnthropicRequest, options: GeminiRequestOptions): RequestResult<GeminiRequestFrame> => {
  if ((Array.isArray(input.system) && input.system.some(isImage)) || input.messages.some(({ content }) => hasImage(content))) {
    return imageUnsupported;
  }
  const contents = mapMessages(input.messages, options);
  if (!contents.ok) return contents;
  const instructions = buildInstructions(input.system);
  return ok({
    ...UNQUALIFIED_MODEL, ...UNQUALIFIED_GENERATION_CONFIG, ...UNQUALIFIED_TOOL_CONFIG,
    ...UNQUALIFIED_SESSION_ID, ...UNQUALIFIED_REQUEST_TYPE, ...UNQUALIFIED_USER_AGENT,
    ...UNQUALIFIED_THINKING_BUDGET,
    request: {
      contents: contents.value,
      ...(instructions === undefined ? {} : { systemInstruction: { role: "user", parts: [{ text: instructions }] } }),
      ...UNQUALIFIED_TOOL_DECLARATIONS,
    },
  });
};
