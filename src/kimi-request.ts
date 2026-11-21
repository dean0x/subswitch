/**
 * The Kimi request: the client's Anthropic Messages request, with the changes that the
 * Kimi coding Messages endpoint and the thinking rule need.
 *
 * Every thinking and redacted_thinking block of the client history is removed, because
 * a client signature belongs to another service. Kimi thinking comes back only from the
 * server-side cache, keyed by the conversation key and the first tool_use id of its turn.
 */
import type { AnthropicMessage, AnthropicRequest } from "./anthropic-wire-types.js";
import { isPlainObject } from "./plain-object.js";
import { reasoningKey } from "./together-request.js";

/** A Kimi thinking block. The leg keeps it on the server and sends it only to Kimi. */
export type KimiThinkingBlock =
  | { readonly type: "thinking"; readonly thinking: string; readonly signature?: string }
  | { readonly type: "redacted_thinking"; readonly data: string };

export interface KimiRequestOptions {
  /** The canonical model id. */
  readonly model: string;
  readonly conversationKey?: string;
  readonly getThinking: (key: string) => readonly KimiThinkingBlock[] | undefined;
}

export type KimiRequestBody = Readonly<Record<string, unknown>> & {
  readonly model: string;
  readonly stream: true;
  readonly messages: readonly AnthropicMessage[];
};

type Block = Readonly<Record<string, unknown>>;

const isThinking = (block: Block): boolean => block["type"] === "thinking" || block["type"] === "redacted_thinking";

/** True for a block that the Kimi stream translator keeps, so a cache entry of another shape is not sent. */
export const isKimiThinkingBlock = (value: unknown): value is KimiThinkingBlock => {
  if (!isPlainObject(value)) return false;
  if (value["type"] === "redacted_thinking") return typeof value["data"] === "string";
  return value["type"] === "thinking" && typeof value["thinking"] === "string" &&
    (value["signature"] === undefined || typeof value["signature"] === "string");
};

const firstToolUseId = (content: readonly Block[]): string | undefined => {
  const id = content.find((block) => block["type"] === "tool_use")?.["id"];
  return typeof id === "string" && id !== "" ? id : undefined;
};

/** The message without client thinking, with the cached Kimi thinking first. Undefined when nothing is left. */
const mapMessage = (message: AnthropicMessage, replay: (toolId: string) => readonly KimiThinkingBlock[] | undefined):
  AnthropicMessage | undefined => {
  if (typeof message.content === "string") return message;
  const kept = message.content.filter((block) => !isThinking(block));
  const toolId = message.role === "assistant" ? firstToolUseId(kept) : undefined;
  const cached = toolId === undefined ? undefined : replay(toolId);
  const content = cached === undefined ? kept : [...cached, ...kept];
  return content.length === 0 ? undefined : { ...message, content };
};

/** Build the Kimi body from a parsed client request. The client request does not change. */
export const buildKimiRequest = (request: AnthropicRequest, options: KimiRequestOptions): KimiRequestBody => {
  const { conversationKey, getThinking } = options;
  const replay = (toolId: string): readonly KimiThinkingBlock[] | undefined =>
    conversationKey === undefined ? undefined : getThinking(reasoningKey(conversationKey, toolId));
  // The client metadata names the client account, so it does not go to Kimi.
  const { metadata: _metadata, ...fields } = request;
  const messages = request.messages.flatMap((message) => mapMessage(message, replay) ?? []);
  // Both client modes use the same upstream stream. The runner folds it for a JSON reply.
  return { ...fields, model: options.model, messages, stream: true };
};
