---
feature: codex-leg
name: Codex translation leg (gpt-* → /responses)
description: "Use when modifying Codex request translation, model alias resolution, session/cache key derivation, protocol headers, reasoning round-trips, or the codex-recorder dev tool. Keywords: codex, gpt, responses, conversation key, session_id, prompt_cache_key, reasoning, effort, translation, model resolver, alias, family, canonical."
category: domain-knowledge
directories: [src]
created: 2026-07-22
updated: 2026-07-26
---

# Codex Translation Leg (gpt-* → /responses)

## Overview

subswitch translates Anthropic Messages API requests into OpenAI Responses API calls against `https://chatgpt.com/backend-api/codex/responses`. Routing is decided in `src/router.ts` by exact match against `config.codex.models` (applies ADR-005). Everything else passes through to the Anthropic leg unchanged.

The pipeline has three distinct stages: **resolve** (alias/family → canonical model id in `server.ts`), **route** (exact membership check in `router.ts`), and **send** (translation + fetch in `codex-handler.ts`). Keeping these stages separate is the load-bearing invariant of ADR-005 — the router only ever sees canonical ids, never bare aliases or family names.

The translation leg is not a simple field rename. Several fields are deliberately dropped (max_tokens), renamed (system → developer role), injected (prompt_cache_key, reasoning.effort), or round-tripped through a server-side cache (encrypted reasoning). These rules exist because the Codex backend differs from the Responses API in ways that are not obvious from its OpenAPI surface.

## Business Context

Claude Code's subagent harness calls subswitch as if it were the Anthropic Messages API. When the model is a `gpt-*` slug (or an alias that resolves to one), subswitch must produce Anthropic-shaped SSE frames on the way back — Claude Code never knows it spoke to a different backend. The translation must be invisible to the caller.

The Codex backend is accessed with the user's ChatGPT subscription OAuth credentials, forwarded from `~/.codex/auth.json` (applies ADR-002). subswitch holds no API keys for this leg.

## Critical Transport Finding (verified live 2026-07-22, codex-cli 0.144.6)

**The real `codex exec` CLI does NOT POST to `/responses` over HTTP for AI inference.** It uses a WebSocket app-server transport (`rpc_transport: "app_server"`). The HTTP calls captured from `codex exec` are analytics and session management only.

Consequence: subswitch's `/responses` protocol constants were independently verified working against the HTTP backend (2026-07-21), not derived from a `codex exec` wire capture. The parity gaps table in `e2e/README.md` (Section "Parity gaps — subswitch vs real CLI") compares subswitch against analytics-endpoint headers from the wrong transport. **Do not use that table to "fix"** the `buildHeaders` function in `codex-handler.ts`.

| subswitch `/responses` header | Status |
|---|---|
| `openai-beta: responses=experimental` | Verified working; keep as-is |
| `originator: codex_cli_rs` | Verified working; keep as-is |
| `accept: text/event-stream` | Verified working; keep as-is |
| `session_id` as request header | Verified working; keep as-is |

## Core Business Rules

### Model Resolution Contract (src/models.ts + src/server.ts)

Model name resolution happens ONCE in `server.ts` before routing, using `makeModelResolver` from `models.ts`. The resolver is built once at process start from the routable set and config aliases. Resolution order (applies ADR-005):

1. **Name is in the routable set** → returns itself. Exact canonical ids ALWAYS win — a config alias can never hijack a real model id.
2. **`codex.aliases` has an own-property entry for the name** → returns its target. Uses a `Map` built with `Object.hasOwn` guard — a bare bracket lookup on a JSON-parsed object returns inherited properties (`obj["constructor"]` returns `Object`), which would silently misroute.
3. **Name is a family** → returns the newest non-preview, non-retired entry of that family **that is in the routable set**. Rule 3 scoping to the routable set is the "a pin pins" invariant — see below.
4. **None of the above** → returns `undefined`. Caller routes to Anthropic.

**"A pin pins."** Rule 3 scopes family resolution to the routable set. A user whose `codex.models` lists `["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna", "gpt-5.5"]` keeps `sol` resolving to `gpt-5.6-sol` even when the registry adds `gpt-5.7-sol`. Without this scoping, a registry bump would silently repoint every existing user's aliases to a model they never allowed.

**Numeric gen tuple comparison.** `[5,10] > [5,6]` and `[6,0] > [5,99]` — comparison is numeric element-wise, NOT string comparison. Longer tuple wins on equal prefix (`[5,6,1] > [5,6]`). On an exact tie the first-declared registry entry wins (update on `> 0` only, not `>= 0`).

**`preview: true`** entries are excluded from alias derivation but resolvable by exact id. **`retired: true`** entries are excluded from alias derivation AND from the default routable set. Neither flag is a deletion — entries are never removed from the registry; deleting one silently unroutes anyone who pinned that id by exact name.

**Canary test.** `test/unit/models.test.ts` asserts that `sol`, `terra`, and `luna` currently resolve to their `gpt-5.6-*` ids. This test is SUPPOSED to fail when a new generation is added to the registry — that is the intentional signal to review which users' aliases will repoint.

**`normalizeModelList(list, overrides, registry?)`.** Called in `loadConfig` after raw JSON extraction but before Zod parse. When `codex.models` is ABSENT from the config JSON, returns all non-retired registry ids plus any alias targets not already in the full registry (pressure valve for forward-compat models). When PRESENT, expands each entry through the alias table, preserves unknowns verbatim (forward-compat), and deduplicates first-occurrence wins. The distinction between absent and present is the "authoritative and narrowing" semantic.

**Anthropic guard on three surfaces.** `isAnthropicModelName` (prefix-based, covering `inherit|sonnet|opus|haiku|claude-*`) is validated at config load time against:
- `codex.aliases` KEYS — a `claude-*` key would resolve inbound Anthropic traffic to a Codex id.
- `codex.aliases` TARGETS — a `claude-*` target is added to the routable set by the pressure valve, and `decideRoute`'s exact-membership check would then match the raw Anthropic model id and route the main Claude Code thread to Codex.
- `codex.models` ENTRIES — same effect as a target via direct routable-set membership.

### Resolve → Route → Send in src/server.ts

```typescript
// model: as-requested name — preserved for request_complete log; NEVER reassigned.
model = peekModel(body.value);
// canonical: resolved id for routing and translation. ?? model fallback ensures
// canonical is always a string when model is defined (Anthropic names resolve to
// undefined, fallback passes them through verbatim for the Anthropic route).
const canonical = model === undefined ? undefined : (resolveModel(model) ?? model);
// decideRoute only sees canonical ids — byte-unchanged from ADR-005. (applies ADR-005)
const decision = decideRoute(req.method ?? "POST", path, canonical, config.codex.models);
// ...
await deps.codex.handleMessages(req, res, body.value, canonical!);
```

The `model` variable logs what the user typed (a typo like `sool` must still log `model=sool`). `canonical` is what everything downstream uses. The separation is intentional — operators grep logs for what they typed; the alias mapping is discoverable via `subswitch models`.

### Canonical threading through handleMessages (src/codex-handler.ts)

`handleMessages` signature: `(req, res, rawBody, canonicalModel: string)`. The canonical model is threaded because `deriveConversationKey` hashes the model string — an alias and its canonical would produce DIFFERENT `session_id` and `prompt_cache_key` without substitution. There is an integration test pinning their equality.

Inside `handleMessages`:

```typescript
const model = parsed.data.model; // as-requested — used only in log calls
// Substitute canonical so key derivation and translation see a stable, alias-free string.
// When inbound is already canonical this is a no-op spread preserving Zod passthrough keys.
const request = canonicalModel === parsed.data.model
  ? parsed.data
  : { ...parsed.data, model: canonicalModel };
const conversationKey = deriveConversationKey(request); // hashes request.model
```

`model` is NEVER reassigned — all log calls use the as-requested name. `request` (with canonical model) is passed to `deriveConversationKey` and `translateRequest`.

### Request translation rules (src/codex-request.ts)

**Fields that are dropped:**
- `max_tokens` — the Codex backend rejects `max_output_tokens` with 400 "Unsupported parameter" (avoids PF-002).

**Fields that are translated:**
- Anthropic `system` field → Responses API `instructions` (top-level string).
- `system`-role messages inside `messages[]` → `developer`-role input items. Claude Code's subagent harness injects system prompts this way (applies PF-003).
- `output_config.effort` → `reasoning: { effort }` (applies PF-004). Validated against the exact set the backend accepts: `none | minimal | low | medium | high | xhigh | max`. Unknown values emit `unsupported_effort_dropped` and degrade to the backend default, never 400.

**Fields that are always injected:**
- `store: false` — prevents reasoning items from persisting server-side (applies ADR-003).
- `include: ["reasoning.encrypted_content"]` — requests encrypted reasoning for cache round-trip (applies ADR-003).
- `stream: true` — always streamed internally; `aggregateFrames` reconstructs non-stream responses.
- `prompt_cache_key` — when a conversation key is derived. Drives prompt caching; 76% hit rate observed live.

**Tool translation:**
- Client-side tools (with `input_schema`) → Responses API `function` type.
- Server-side tools (no `input_schema`, e.g. `web_search`) → skipped, emit `unsupported_tool_skipped`.
- `cache_control` metadata on tool schemas is stripped — the Responses API does not accept it.

### Conversation key derivation (src/conversation-key.ts)

The conversation key is a deterministic, v7-shaped UUID. It drives BOTH `prompt_cache_key` in the outbound request body AND `session_id` in request headers.

Derivation: `sha256(capBytes(model) + " " + capBytes(buildInstructions(system)) + " " + capBytes(JSON.stringify(firstUserMessage)))`

Where:
- `capBytes` truncates each component to 16 KB to bound hash cost.
- `buildInstructions(system)` extracts text from `request.system` (not from `builder.items`).
- `firstUserMessage` is from the **raw inbound request** with canonical model substituted — not from builder output, which may have system-role messages translated to developer-role (PF-003).
- Returns `undefined` when no user message is present; callers fall back to `randomUUID()`.

**The model field in the request MUST be canonical** when passed to `deriveConversationKey`. An alias (`sol`) and its canonical (`gpt-5.6-sol`) hash differently — different `session_id`, different `prompt_cache_key`, different prompt-cache hit rate. This is why canonical threading through `handleMessages` is load-bearing.

**Volatile-system escape hatch:** If Claude Code mutates the `system` prompt mid-conversation, the key flaps each turn. To decouple the key from instructions, set the `instructionsComponent` assignment in `conversation-key.ts` to `""`. That is the only edit required.

### session_id stability across the 401-refresh retry (src/codex-handler.ts)

`sessionId` is computed ONCE before the `for (let attempt = 0; attempt < 2; attempt++)` loop. Both the initial attempt and the 401-refresh retry use the same value. Do not move session_id derivation inside the loop — the retry must reuse the same id for backend session correlation.

## Technical Implementation Patterns

### Data flow through the Codex leg

```
IncomingMessage (Anthropic wire)
  → bufferBody (raw bytes preserved — Content-Length stays valid)
  → peekModel (as-requested name for logs; never reassigned)
  → resolveModel (alias/family → canonical; ?? fallback for unknowns)
  → decideRoute (exact canonical membership in config.codex.models)
  → AnthropicRequestSchema.safeParse (parse + validate)
  → canonical substitution (model field → canonical in `request`)
  → deriveConversationKey (hashes canonical model + system + first user msg)
  → translateRequest (codex-request.ts; ReasoningCache for reasoning re-injection)
  → buildHeaders (credentials + sessionId; 401-retry loop; same sessionId both attempts)
  → fetch POST /responses
  → createSseParser (chunk → SseEvent)
  → createAnthropicSseTranslator (SseEvent → Anthropic SSE frame)
  → stream to client (or aggregateFrames for non-streaming callers)
```

### Reasoning round-trip (src/codex-request.ts + codex-response.ts)

`include: ["reasoning.encrypted_content"]` causes the backend to emit reasoning items in `response.output_item.done` events. `createAnthropicSseTranslator` buffers these and calls `onReasoningItems(callId, items)` when a function_call item completes. The `ReasoningCache` stores `callId → items[]`.

On the next turn, when an assistant message contains a `tool_use` block, `translateAssistantMessage` calls `injectReasoningItems(builder, cache, callId)`. The cache injects encrypted reasoning items immediately before the `function_call` item. A cache miss emits `reasoning_cache_miss` (degraded, not broken: the model loses chain-of-thought but the conversation continues).

Deduplication: reasoning items carry an `id` field. `injectedReasoningIds` tracks which ids have been injected in a single pass to prevent duplicates when parallel tool calls share the same buffered reasoning.

### Cache and session observability (src/logger.ts, src/codex-response.ts)

Two debug-level log fields in the closed `FIELD_KEYS` set prove the caching machinery works without leaking content:

- `cachedTokens` — from `response.usage.input_tokens_details.cached_tokens`. Non-zero values prove `prompt_cache_key` is effective (76% hit rate observed live).
- `sessionKey` — first 8 hex chars of the conversation key UUID. Verifies key stability across turns. Truncated, non-reversible.

## Error Handling and Recovery

| Failure | Handling |
|---|---|
| 401 before streaming begins | One forced credential refresh (`auth.forceRefresh()`), then retry once. If still 401, `auth` error returned to client. |
| Non-2xx upstream (non-401) | Error body peeked (2 KB cap), mapped to Anthropic error shape, `retry-after` header forwarded when present. |
| Mid-stream upstream failure | After `message_start` is already sent, emit `toAnthropicErrorSse("api_error", …)` and close. Never retry mid-stream. |
| Abort (client close or timeout) | `AbortController` shared between `res.on("close")` and `setTimeout(requestTimeoutMs)`. Idle stream timeout reset on each data chunk. |
| `reasoning_cache_miss` | Degraded, not broken. Warning logged as `errorCode`. |
| `unsupported_effort_dropped` | Unknown effort value silently ignored; backend uses its default reasoning level. |

## Anti-Patterns

**Aligning `/responses` headers to `codex exec` wire captures.** The parity gaps table in `e2e/README.md` documents analytics-endpoint headers from the wrong transport. Changing `buildHeaders` to match that table will break the working `/responses` HTTP leg.

**Deriving the conversation key from builder output.** `deriveConversationKey` must receive `request` (with canonical model substitution), not the result of `translateRequest`. The builder translates `system`-role messages to `developer`-role items (PF-003) and the key must hash the original first user message from the canonical request.

**Passing an alias instead of a canonical to handleMessages.** The 4th parameter `canonicalModel` must be a resolved canonical id. Passing a bare alias (`"sol"`) means `deriveConversationKey` hashes the alias string — the session_id and prompt_cache_key will differ from those of a request that used the canonical directly, breaking cache coherence and session correlation.

**Moving sessionId derivation inside the retry loop.** The 401-refresh retry reuses the same `sessionId` computed before the loop. A new id per attempt breaks session correlation on the backend.

**Passing `max_tokens`/`max_output_tokens` to the Responses API.** The Codex backend returns 400 for this field. Drop it unconditionally (avoids PF-002).

**Routing before resolving.** `decideRoute` must only receive canonical model ids (applies ADR-005). Passing an alias or family name directly to `decideRoute` is always a bug — the alias would fail the exact-membership check and send the request to Anthropic, silently ignoring the user's routing intent.

## Gotchas

**`stream: true` is always sent, even when the client sets `stream: false`.** subswitch always requests an SSE stream from the backend, then `aggregateFrames` assembles a non-streaming response.

**`session_id` appears in two different places with different semantics.** In subswitch's `buildHeaders`, it is a request header. In live `codex exec` analytics captures, `session_id` appears as a body field in analytics POSTs. These are different transports.

**`prompt_cache_key` is absent from `codex exec` HTTP captures.** This is correct — inference goes via WebSocket, not HTTP. The field IS valid on the `/responses` HTTP API (proved by 76% cache hit observed live 2026-07-21).

**Parallel tool calls share reasoning items.** When the backend returns multiple function calls in one response, all share the same `reasoningItems` buffer. `injectReasoningItems` deduplicates by `item.id` using `injectedReasoningIds`, but the reasoning items are re-injected for each call. This is by design.

**The volatile-system key flap is a latent footgun.** Claude Code may mutate the `system` prompt at the start of each turn. If it does, the conversation key changes with every request, defeating prompt caching and producing a new session_id each turn. The escape hatch (set `instructionsComponent = ""`) is the one-line fix.

**Anthropic-name guard must cover all three surfaces.** The targets case is the easiest to miss — `{"fast": "claude-sonnet-4-5"}` adds `claude-sonnet-4-5` to the routable set via the pressure valve in `normalizeModelList`, and `decideRoute`'s exact-membership check then routes the entire main Claude Code thread to Codex. The predicate is intentionally prefix-based so variant tier names are caught.

**`Object.hasOwn` is required for alias lookup.** A bare `aliases[name]` on a JSON-parsed object returns inherited properties — `aliases["constructor"]` returns `Object`. The resolver builds an intermediate `Map` using `Object.hasOwn` during construction, so all lookups at request time are prototype-pollution safe.

## Key Files

- `src/server.ts` — Wiring site for the resolve→route→send split; `resolveModel` built once at startup; `peekModel` + `canonical` + `decideRoute` + `handleMessages(canonical)` pattern
- `src/models.ts` — Pure registry module (no repo imports); `MODEL_REGISTRY`, `makeModelResolver` (4-rule contract), `normalizeModelList`, `isAnthropicModelName`, `formatModelsReport`
- `src/codex-handler.ts` — `handleMessages(req, res, rawBody, canonicalModel)` entry point; canonical substitution; session_id capture (before loop); 401-retry loop; stream/aggregate routing
- `src/codex-request.ts` — All request translation logic; `buildInstructions`, `translateRequest`, `translateEffort`
- `src/conversation-key.ts` — Deterministic v7-shaped UUID derivation from sha256 of canonical request
- `src/codex-response.ts` — SSE parser, Anthropic SSE translator state machine, `aggregateFrames`
- `src/router.ts` — Pure routing decision by canonical model name; byte-unchanged; no side effects; never sees an alias (a router test pins this layering)
- `src/config.ts` — `codex.aliases` and `codex.models` schemas; `LoadConfigResult.codexModelsPinned`; `normalizeModelList` called at load time
- `src/logger.ts` — Closed `FIELD_KEYS` set (redaction mechanism); `cachedTokens` and `sessionKey` fields; log injection prevention
- `src/wire-types.ts` — `AnthropicRequestSchema` (inbound parse); `ModelPeekSchema` with `.max(200)` bound; Responses* schemas
- `e2e/capture/codex-recorder.ts` — Dev-only transparent forwarder on 127.0.0.1:4142; excluded from npm test; NEVER commit real captures
- `e2e/README.md` — Transport finding, parity gap table (wrong-transport context), recorder usage

## Related

- ADR-005 (Accepted): Route Codex-leg traffic by exact membership in `codex.models`; resolution happens strictly before `decideRoute`, which still does exact membership on the canonical — this feature does not weaken ADR-005
- ADR-001 (Superseded by ADR-005): Old prefix-matching framing; cited in the initial `codex-leg` overview but now superseded; use ADR-005 for all routing citations
- ADR-002: Subscription OAuth passthrough — credentials flow from `~/.codex/auth.json`
- ADR-003: `store:false` encrypted reasoning round-trip — `include` field + `ReasoningCache`; `sessionId` derived once outside the 401-refresh retry loop
- ADR-004: `@types/node` pinned to Node-22 major — `readdir({recursive:true})` used in doctor; `fs.glob` is forbidden
- PF-002: Drop `max_output_tokens` — backend rejects this field with 400
- PF-003: `system`-role → `developer`-role translation — subagent harness injects system prompts as `system`-role messages
- PF-004: `output_config.effort` → `reasoning.effort` — Claude Code effort frontmatter propagation
- PF-006: Doctor's non-zero exit is load-bearing and always fails in CI; never assert `doctor` exits 0
- `.devflow/features/cli-ux/KNOWLEDGE.md` — CLI UX layer; `subswitch models` command; `DoctorIO.listAgentFiles`; agent-scan Anthropic skip list
