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

export const ModelPeekSchema = z.object({ model: z.string() });

// ---------------------------------------------------------------------------
// OpenAI Responses API SSE events (outbound from Codex). Discriminated by the
// `type` field at the call site; every schema is passthrough so upstream drift
// degrades to ignored fields, never to hard failures.
// ---------------------------------------------------------------------------

export const ResponsesEventEnvelopeSchema = z.object({ type: z.string() }).passthrough();

export const ResponsesOutputItemSchema = z
  .object({
    type: z.string(),
    id: z.string().optional(),
    call_id: z.string().optional(),
    name: z.string().optional(),
    arguments: z.string().optional(),
  })
  .passthrough();

export const ResponsesOutputItemEventSchema = z
  .object({
    type: z.string(),
    output_index: z.number().optional(),
    item: ResponsesOutputItemSchema,
  })
  .passthrough();

export const ResponsesDeltaEventSchema = z
  .object({
    type: z.string(),
    item_id: z.string().optional(),
    output_index: z.number().optional(),
    delta: z.string(),
  })
  .passthrough();

export const ResponsesResponseObjectSchema = z
  .object({
    id: z.string().optional(),
    model: z.string().optional(),
    status: z.string().optional(),
    incomplete_details: z.object({ reason: z.string().optional() }).passthrough().nullish(),
    usage: z
      .object({
        input_tokens: z.number().optional(),
        output_tokens: z.number().optional(),
        input_tokens_details: z
          .object({
            cached_tokens: z.number().optional(),
          })
          .passthrough()
          .optional(),
      })
      .passthrough()
      .nullish(),
    error: z.record(z.string(), z.unknown()).nullish(),
  })
  .passthrough();

export const ResponsesLifecycleEventSchema = z
  .object({
    type: z.string(),
    response: ResponsesResponseObjectSchema,
  })
  .passthrough();

export const ResponsesErrorEventSchema = z
  .object({
    type: z.string(),
    code: z.string().nullish(),
    message: z.string().nullish(),
  })
  .passthrough();

// ---------------------------------------------------------------------------
// OAuth token endpoint + auth.json. Passthrough at every level so unknown keys
// written by the Codex CLI survive subswitch's read-modify-write cycle.
// ---------------------------------------------------------------------------

export const AuthTokensSchema = z
  .object({
    id_token: z.string().optional(),
    access_token: z.string(),
    refresh_token: z.string(),
    account_id: z.string().optional(),
  })
  .passthrough();

export const AuthFileSchema = z
  .object({
    tokens: AuthTokensSchema,
    last_refresh: z.string().optional(),
    auth_mode: z.string().optional(),
  })
  .passthrough();

export type AuthFile = z.infer<typeof AuthFileSchema>;

export const TokenResponseSchema = z
  .object({
    access_token: z.string(),
    id_token: z.string().optional(),
    refresh_token: z.string().optional(),
  })
  .passthrough();

export type TokenResponse = z.infer<typeof TokenResponseSchema>;
