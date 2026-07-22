---
feature: codex-leg
name: Codex translation leg (gpt-* → /responses)
description: "Use when modifying Codex request translation, session/cache key derivation, protocol headers, reasoning round-trips, or the codex-recorder dev tool. Keywords: codex, gpt, responses, conversation key, session_id, prompt_cache_key, reasoning, effort, translation."
category: domain-knowledge
directories: [src]
created: 2026-07-22
updated: 2026-07-22
---

# Codex Translation Leg (gpt-* → /responses)

## Overview

croxy translates Anthropic Messages API requests (`gpt-*` model names) into OpenAI Responses API
calls against `https://chatgpt.com/backend-api/codex/responses`. Routing is decided in
`src/router.ts` by exact match against `config.codex.models` (applies ADR-001). Everything else
passes through to the Anthropic leg unchanged.

The translation leg is not a simple field rename. Several fields are deliberately dropped
(max_tokens), renamed (system → developer role), injected (prompt_cache_key, reasoning.effort),
or round-tripped through a server-side cache (encrypted reasoning). These rules exist because the
Codex backend differs from the Responses API in ways that are not obvious from its OpenAPI surface.

## Business Context

Claude Code's subagent harness calls croxy as if it were the Anthropic Messages API. When the
model is a `gpt-*` slug, croxy must produce Anthropic-shaped SSE frames on the way back — Claude
Code never knows it spoke to a different backend. The translation must be invisible to the caller.

The Codex backend is accessed with the user's ChatGPT subscription OAuth credentials, forwarded
from `~/.codex/auth.json` (applies ADR-002). croxy holds no API keys for this leg.

## Critical Transport Finding (verified live 2026-07-22, codex-cli 0.144.6)

**The real `codex exec` CLI does NOT POST to `/responses` over HTTP for AI inference.**
It uses a WebSocket app-server transport (`rpc_transport: "app_server"`). The HTTP calls captured
from `codex exec` are analytics and session management only.

Consequence: croxy's `/responses` protocol constants were independently verified working against
the HTTP backend (2026-07-21), not derived from a `codex exec` wire capture. The parity gaps
table in `e2e/README.md` (Section "Parity gaps — croxy vs real CLI") compares croxy against
analytics-endpoint headers from the wrong transport. **Do not use that table to "fix"** the
`buildHeaders` function in `codex-handler.ts`.

What this means concretely:

| croxy `/responses` header | Status |
|---|---|
| `openai-beta: responses=experimental` | Verified working; keep as-is |
| `originator: codex_cli_rs` | Verified working; keep as-is |
| `accept: text/event-stream` | Verified working; keep as-is |
| `session_id` as request header | Verified working; keep as-is |

The "wrong-transport" parity table records what the CLI sends to analytics endpoints. It is
preserved in `e2e/README.md` for future audit but must not drive header changes on the
`/responses` HTTP path.

## Core Business Rules

### Request translation rules (src/codex-request.ts)

**Fields that are dropped and why:**

- `max_tokens` — the Codex backend rejects `max_output_tokens` with 400 "Unsupported parameter"
  (avoids PF-002). Drop it silently rather than failing the request.

**Fields that are translated:**

- Anthropic `system` field → Responses API `instructions` (top-level string, not a message item).
- `system`-role messages inside `messages[]` → `developer`-role input message items. Claude Code's
  subagent harness injects system prompts this way (applies PF-003).
- `output_config.effort` → `reasoning: { effort }` (applies PF-004). Validated against the exact
  set the backend accepts: `none | minimal | low | medium | high | xhigh | max`. Unknown values
  emit `unsupported_effort_dropped` warning and degrade to the backend default, never 400.

**Fields that are always injected:**

- `store: false` — prevents reasoning items from persisting server-side (applies ADR-003).
- `include: ["reasoning.encrypted_content"]` — requests encrypted reasoning in the response so
  croxy can cache it server-side and re-inject on the next turn (applies ADR-003).
- `stream: true` — always streamed internally; croxy's aggregator reconstructs non-stream
  responses for callers that set `stream: false`.
- `prompt_cache_key` — injected when a conversation key is derived (see below). Drives prompt
  caching; 76% hit rate observed live.

**Tool translation:**

- Client-side tools (with `input_schema`) → Responses API `function` type.
- Server-side tools (no `input_schema`, e.g., `web_search`) → skipped, emit
  `unsupported_tool_skipped` warning.
- `cache_control` metadata on tool schemas is stripped — the Responses API does not accept it.

### Conversation key derivation (src/conversation-key.ts)

The conversation key is a deterministic, v7-shaped UUID. It drives BOTH `prompt_cache_key` in the
outbound request body AND `session_id` in request headers. The real codex-cli uses UUID v7 for
its session_id; croxy forces the version nibble to 7 and variant bits to 10xx for fingerprint
parity.

Derivation: `sha256(capBytes(model) + " " + capBytes(buildInstructions(system)) + " " + capBytes(JSON.stringify(firstUserMessage)))`

Where:
- `capBytes` truncates each component to 16 KB to bound hash cost on pathological inputs.
- `buildInstructions(system)` extracts the text from `request.system` (not from `builder.items`).
- `firstUserMessage` is taken from the **raw inbound request**, not from the translated builder
  output (which may have system-role messages translated to developer-role per PF-003).
- Returns `undefined` when there is no user message; callers fall back to `randomUUID()`.

**Volatile-system escape hatch:** If Claude Code mutates the `system` prompt mid-conversation,
the key flaps (different instructions → different hash → different session_id). To decouple the
key from instructions, change the `instructionsComponent` assignment in `conversation-key.ts` to
`""`. That is the only edit required — the binding is intentionally kept so the template literal
still compiles.

### session_id stability across the 401-refresh retry (src/codex-handler.ts)

`sessionId` is computed once, before the `for (let attempt = 0; attempt < 2; attempt++)` retry
loop in `handleMessages`. Both the initial attempt and the 401-refresh retry use the same value.
Do not move session_id derivation inside the loop — the retry must reuse the same id so the
backend can correlate the two attempts as the same session.

## Technical Implementation Patterns

### Data flow through the Codex leg

```
IncomingMessage (Anthropic wire)
  → parse + validate (AnthropicRequestSchema, Zod)
  → deriveConversationKey (raw request, returns v7 UUID or undefined)
  → translateRequest (codex-request.ts, uses ReasoningCache for reasoning re-injection)
  → buildHeaders (credentials + sessionId)
  → fetch POST /responses (with bounded 2-attempt retry on 401)
  → createSseParser (chunk → SseEvent)
  → createAnthropicSseTranslator (SseEvent → Anthropic SSE frame)
  → stream to client (or aggregateFrames for non-streaming callers)
```

### Reasoning round-trip (src/codex-request.ts + codex-response.ts)

`include: ["reasoning.encrypted_content"]` causes the backend to emit reasoning items in
`response.output_item.done` events. `createAnthropicSseTranslator` buffers these reasoning items
and calls `onReasoningItems(callId, items)` when a function_call item completes. The
`ReasoningCache` stores `callId → items[]`.

On the next turn, when an assistant message contains a `tool_use` block, `translateAssistantMessage`
calls `injectReasoningItems(builder, cache, callId)`. The cache injects the encrypted reasoning
items immediately before the `function_call` item in `builder.items`. If the cache misses, it
emits `reasoning_cache_miss` (degraded, not broken: the model loses chain-of-thought but the
conversation continues).

Deduplication: reasoning items carry an `id` field. `injectedReasoningIds` tracks which ids have
been injected in a single translation pass to prevent duplicates when parallel tool calls share
the same buffered reasoning.

### Cache and session observability (src/logger.ts, src/codex-response.ts)

Two debug-level log fields in the closed `FIELD_KEYS` set prove the caching machinery works
without leaking content:

- `cachedTokens` — from `response.completed` → `response.usage.input_tokens_details.cached_tokens`.
  Non-zero values prove `prompt_cache_key` is effective (observed 76% hit live).
- `sessionKey` — first 8 hex chars of the conversation key UUID (before the first dash).
  Verifies key stability across turns (same `sessionKey` in every `codex_session_key` event).
  Truncated, non-reversible.

The closed `FIELD_KEYS` constant in `logger.ts` is the redaction mechanism. Fields not in this
set cannot appear in logs regardless of what is passed to `logger.log()`.

## Error Handling and Recovery

| Failure | Handling |
|---|---|
| 401 before streaming begins | One forced credential refresh (`auth.forceRefresh()`), then retry the request once. If still 401, `auth` error returned to client. |
| Non-2xx upstream (non-401) | Error body peeked (2 KB cap), mapped to Anthropic error shape, `retry-after` header forwarded when present. |
| Mid-stream upstream failure | After `message_start` is already sent, emit `toAnthropicErrorSse("api_error", …)` and close. Never retry mid-stream. |
| Abort (client close or timeout) | `AbortController` shared between `res.on("close")` and `setTimeout(requestTimeoutMs)`. Idle stream timeout (`streamIdleTimeoutMs`) is reset on each data chunk. |
| `reasoning_cache_miss` | Degraded, not broken. Warning logged as `errorCode`. Model loses prior chain-of-thought but conversation continues. |
| `unsupported_effort_dropped` | Unknown effort value silently ignored; backend uses its default reasoning level. |

## Anti-Patterns

**Aligning `/responses` headers to `codex exec` wire captures.** The parity gaps table in
`e2e/README.md` documents analytics-endpoint headers from `codex exec`, which uses a WebSocket
transport for inference. Changing `buildHeaders` in `codex-handler.ts` to match that table will
break the working `/responses` HTTP leg.

**Deriving the conversation key from builder output.** `deriveConversationKey` must receive
`parsed.data` (the validated raw inbound request), not the result of `translateRequest`. The
builder translates `system`-role messages to `developer`-role items (PF-003); the key must hash
the original first user message, not a possibly-reordered builder list.

**Moving sessionId derivation inside the retry loop.** The 401-refresh retry reuses the same
`sessionId` computed before the loop. Computing a new one per attempt breaks session correlation
on the backend.

**Passing `max_tokens`/`max_output_tokens` to the Responses API.** The Codex backend returns 400
for this field. Drop it unconditionally (avoids PF-002).

## Gotchas

**`stream: true` is always sent, even when the client sets `stream: false`.** croxy always
requests an SSE stream from the backend, then `aggregateFrames` assembles a non-streaming response
from the Anthropic SSE frames it has already emitted. The `wantStream` flag controls only how
croxy writes to the client, not how it reads from the backend.

**`session_id` appears in two different places with different semantics.** In croxy's
`buildHeaders`, it is a request header. In the live `codex exec` analytics captures, `session_id`
appears as a body field in analytics POST payloads. These are different transports and the
discrepancy is expected and intentional.

**`prompt_cache_key` is absent from `codex exec` HTTP captures.** This is correct — inference
goes via WebSocket, not HTTP. The field IS valid on the `/responses` HTTP API (proved by 76% cache
hit observed live 2026-07-21).

**Parallel tool calls share reasoning items.** When the backend returns multiple function calls in
one response, all share the same `reasoningItems` buffer. `injectReasoningItems` deduplicates by
`item.id` using `injectedReasoningIds`, but the reasoning items are re-injected for each call.
This is by design: the backend needs them associated with each call.

**The volatile-system key flap is a latent footgun.** Claude Code may mutate the `system` prompt
at the start of each turn. If it does, the conversation key changes with every request, defeating
prompt caching and producing a new session_id each turn. The escape hatch (drop
`instructionsComponent`) is documented in `conversation-key.ts` and is a one-line fix.

## Key Files

- `src/codex-handler.ts` — entry point; session_id capture, 401 retry loop, stream/aggregate routing
- `src/codex-request.ts` — all request translation logic; buildInstructions, translateRequest, translateEffort
- `src/conversation-key.ts` — deterministic v7-shaped UUID derivation from sha256 of raw request
- `src/codex-response.ts` — SSE parser, Anthropic SSE translator state machine, aggregateFrames
- `src/router.ts` — pure routing decision by model name; no side effects
- `src/logger.ts` — closed FIELD_KEYS set (the redaction mechanism); cachedTokens and sessionKey fields
- `src/config.ts` — codex.baseUrl, codex.models, codex.userAgent (config knobs for Codex leg)
- `src/wire-types.ts` — AnthropicRequestSchema (inbound parse); Responses* schemas (outbound parse)
- `e2e/capture/codex-recorder.ts` — dev-only transparent forwarder on 127.0.0.1:4142 with structural credential redaction; excluded from npm test; NEVER commit real captures
- `e2e/README.md` — transport finding, parity gap table (wrong-transport context), recorder usage

## Related

- ADR-001: Route by model prefix — exact `codex.models` match in `decideRoute`
- ADR-002: Subscription OAuth passthrough — credentials flow from `~/.codex/auth.json`
- ADR-003: Codex `store:false` encrypted reasoning round-trip — `include` field + `ReasoningCache`
- PF-002: Drop `max_output_tokens` — backend rejects this field with 400
- PF-003: `system`-role → `developer`-role translation — subagent harness injects system prompts as `system`-role messages
- PF-004: `output_config.effort` → `reasoning.effort` — Claude Code effort frontmatter propagation
