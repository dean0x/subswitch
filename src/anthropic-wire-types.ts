import { z } from "zod";

// ---------------------------------------------------------------------------
// Anthropic Messages API (inbound). Tolerant: passthrough everywhere so fields
// we don't model survive round-trips and never cause spurious 400s.
// ---------------------------------------------------------------------------

const ContentBlock = z.record(z.string(), z.unknown());

export const AnthropicToolSchema = z
  .object({
    name: z.string(),
    description: z.string().optional(),
    input_schema: z.record(z.string(), z.unknown()).optional(),
  })
  .passthrough();

export const AnthropicMessageSchema = z
  .object({
    role: z.string(),
    content: z.union([z.string(), z.array(ContentBlock)]),
  })
  .passthrough();

export const AnthropicRequestSchema = z
  .object({
    model: z.string(),
    max_tokens: z.number().int().positive().optional(),
    stream: z.boolean().optional(),
    system: z.union([z.string(), z.array(ContentBlock)]).optional(),
    messages: z.array(AnthropicMessageSchema),
    tools: z.array(AnthropicToolSchema).optional(),
    tool_choice: z.record(z.string(), z.unknown()).optional(),
    output_config: z.object({ effort: z.string().optional() }).passthrough().optional(),
  })
  .passthrough();

export type AnthropicRequest = z.infer<typeof AnthropicRequestSchema>;
export type AnthropicMessage = z.infer<typeof AnthropicMessageSchema>;
export type AnthropicTool = z.infer<typeof AnthropicToolSchema>;

// Length-bound prevents a crafted `model` value from forging a log line via newline injection.
// 200 chars is generous for any real model id but rejects pathological payloads.
export const ModelPeekSchema = z.object({ model: z.string().max(200) });
