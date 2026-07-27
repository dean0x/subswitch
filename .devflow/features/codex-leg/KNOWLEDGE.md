---
feature: codex-leg
name: Codex translation leg (gpt-* → /responses)
description: "Use when modifying Codex request translation, model alias resolution, session/cache key derivation, protocol headers, reasoning round-trips, or the codex-recorder dev tool. Keywords: codex, gpt, responses, conversation key, session_id, prompt_cache_key, reasoning, effort, translation, routing table, alias, family, canonical, buildRoutingTable, resolveModel, ModelResolution."
category: domain-knowledge
directories: [src]
created: 2026-07-22
updated: 2026-07-27
---

# Codex Translation Leg (gpt-* → /responses)

## Overview

subswitch translates Anthropic Messages API requests into OpenAI Responses API calls against `https://chatgpt.com/backend-api/codex/responses`. Routing is decided by `resolveModel` (in `src/models.ts`) and `decideRoute` (in `src/router.ts`), with `MODEL_REGISTRY` as the sole source of routable models (applies ADR-006). Everything else passes through to the Anthropic leg unchanged.

The pipeline has three distinct stages: **resolve** (alias/family → canonical model in `server.ts`), **route** (dispatch decision in `router.ts`), and **send** (translation + fetch in `codex-handler.ts`). Keeping these stages separate is the load-bearing invariant of ADR-005 — the router accepts a typed `ModelResolution`, never a raw string, so name matching cannot creep back in.

The translation leg is not a simple field rename. Several fields are deliberately dropped (max_tokens), renamed (system → developer role), injected (prompt_cache_key, reasoning.effort), or round-tripped through a server-side cache (encrypted reasoning). These rules exist because the Codex backend differs from the Responses API in ways that are not obvious from its OpenAPI surface.

## Business Context

Claude Code's subagent harness calls subswitch as if it were the Anthropic Messages API. When the model resolves to a Codex entry in `MODEL_REGISTRY`, subswitch must produce Anthropic-shaped SSE frames on the way back — Claude Code never knows it spoke to a different backend. The translation must be invisible to the caller.

The Codex backend is accessed with the user's ChatGPT subscription OAuth credentials, forwarded from `~/.codex/auth.json` (applies ADR-002). subswitch holds no API keys for this leg.

## Critical Transport Finding (verified live 2026-07-22, codex-cli 0.144.6)

**The real `codex exec` CLI does NOT POST to `/responses` over HTTP for AI inference.** It uses a WebSocket app-server transport (`rpc_transport: "app_server"`). The HTTP calls captured from `codex exec` are analytics and session management only.

Consequence: subswitch's `/responses` protocol constants were independently verified working against the HTTP backend (2026-07-21), not derived from a `codex exec` wire capture. The parity gaps table in `e2e/README.md` (Section "Parity gaps — subswitch vs real CLI") compares subswitch against analytics-endpoint headers from the wrong transport. **Do not use that table to "fix"** the `buildHeaders` function in `codex-handler.ts` (avoids PF-005).

| subswitch `/responses` header | Status |
|---|---|
| `openai-beta: responses=experimental` | Verified working; keep as-is |
| `originator: codex_cli_rs` | Verified working; keep as-is |
| `accept: text/event-stream` | Verified working; keep as-is |
| `session_id` as request header | Verified working; keep as-is |

## Core Business Rules

### Routing Table Architecture

`MODEL_REGISTRY` (in `src/models.ts`) is the **sole source** of routable models (applies ADR-006). `buildRoutingTable(registry, aliasesByProvider)` is called **once** in `buildDeps` at startup and is **pure** (no I/O, no credential checks, deterministic). It returns a `RoutingTableBuild` with:

- `table.byId` — all registry entries including retired and preview; maps canonical id → provider.
- `table.byFamily` — per-family resolution: unique claimant → `{ kind: "unique", model }`, contested → `{ kind: "ambiguous", providers }`. Retired and preview entries are **excluded**.
- `table.byQualified` — `"provider:id"` for all registry entries; `"provider:family"` for the per-provider family winner including **contested** families (qualifying is the disambiguation mechanism).
- `table.byAlias` — config aliases with `Object.hasOwn` guard and PF-007 Anthropic-name rejection. Exactly **one hop**: `a → b` where `b` is itself an alias does not follow through.

Credential state is deliberately **not** an input to `buildRoutingTable`: gating routability on credential presence turns a clear `401 "run codex login"` into an opaque Anthropic 404, collapsing two distinguishable failure modes into one.

`buildRoutingTable` is **total** — problems (rejected aliases, dangling targets, ambiguous families, reserved-name registry entries) are returned as diagnostic lists in `RoutingTableBuild`, not thrown. `buildDeps` logs each diagnostic and moves on.

### Five-Rule Resolution Contract (src/models.ts — resolveModel)

`resolveModel(table, name)` returns a `ModelResolution` discriminated union. Rules execute in order; the first match wins:

1. **Exact id** in `byId` → `{ kind: "resolved" }`. Canonical ids ALWAYS win — no alias can hijack a real model id. Retired and preview models are routable here.
2. **Alias** in `byAlias` → `{ kind: "resolved" }`. One hop only; Map built with `Object.hasOwn` at table-build time — prototype-pollution safe at request time.
3. **Qualified** `"provider:id"` or `"provider:family"` in `byQualified` → `{ kind: "resolved" }` when the prefix is in `PROVIDER_IDS`. An unknown prefix returns `{ kind: "unknown_qualifier" }` so callers can distinguish "bad provider" from "bad model". A known prefix with an unknown id/family returns `{ kind: "unresolved" }`.
4. **Family** in `byFamily` → unique claimant: `{ kind: "resolved" }`; contested: `{ kind: "ambiguous", name, providers }`.
5. **Otherwise** → `{ kind: "unresolved" }`. Caller routes to Anthropic.

**Retired models are in `byId` but not in `byFamily`.** An exact-id pin on a retired model keeps routing and receives a truthful upstream error; a bare family name never floats onto a retired model.

**Qualifying disambiguates contests.** A family claimed by two providers returns `ambiguous` from rule 4, but `codex:sol` still resolves via rule 3 — that is the entire point of qualified names. `byQualified` intentionally includes contested families; omitting them inverts the feature.

**Numeric gen tuple comparison.** `[5,10] > [5,6]` and `[6,0] > [5,99]` — comparison is numeric element-wise, NOT string comparison. Longer tuple wins on equal prefix (`[5,6,1] > [5,6]`). On exact tie, first-declared registry entry wins (update on `> 0` only, not `>= 0`).

**`preview: true`** entries are excluded from `byFamily` but resolvable by exact id. **`retired: true`** entries are excluded from `byFamily` and from qualified-family lookups, but resolvable by exact id and by `"provider:id"` qualified lookup.

**Canary test.** `test/unit/models.test.ts` asserts that `sol`, `terra`, and `luna` currently resolve to their `gpt-5.6-*` ids. This test is SUPPOSED to fail when a new generation is added to the registry — that is the intentional signal to review which agents' `model:` lines will repoint.

**`isReservedAnthropicName` (renamed from `isAnthropicModelName`; regex unchanged).** Prefix-based, covering `inherit|sonnet|opus|haiku|claude-*`. Used in two places that must never disagree:
- `config.ts` AliasesSchema refines — reject alias keys or values at config-parse time.
- `buildRoutingTable` `byAlias` construction — entries matching the predicate are added to `rejectedAliases` and skipped.

### Resolve → Route → Send in src/server.ts

The body is JSON-parsed **once** in `server.ts`. The parsed value (`parsedBody`) is passed to the provider handler so it never needs to call `JSON.parse` again (P4 contract).

```typescript
// model: as-requested name — preserved for request_complete log; NEVER reassigned.
model = peekModel(parsedBody);

// Resolve once, strictly before routing (ADR-005). deps.resolve is a closure over
// the routing table built once at startup — structural guarantee (no per-request rebuild).
const resolution = model !== undefined
  ? deps.resolve(model)
  : { kind: "unresolved" as const };
const decision = decideRoute(req.method ?? "POST", path, resolution);
// ...
await deps.providers[decision.provider].handleMessages(
  req, res, body.value, parsedBody, decision.model,
  // decision.model is the canonical id carried on the resolved ResolvedModel.
);
```

`route` log field format: `"provider:endpoint:model"` (e.g., `"codex:messages:gpt-5.6-sol"`). `model` in the log is always the as-requested name — a typo still logs `model=sool`.

### Canonical threading through handleMessages (src/codex-handler.ts)

`handleMessages` signature: `(req, res, rawBody, parsed, canonicalModel)`. The canonical model is threaded because `deriveConversationKey` hashes the model string — an alias and its canonical produce DIFFERENT `session_id` and `prompt_cache_key` without substitution. There is an integration test pinning their equality.

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

### Request translation rules (src/codex-request.ts + src/anthropic-parse.ts)

**Fields that are dropped:**
- `max_tokens` — the Codex backend rejects `max_output_tokens` with 400 "Unsupported parameter" (avoids PF-002).

**Fields that are translated:**
- Anthropic `system` field → Responses API `instructions` (top-level string). `buildInstructions` lives in `src/anthropic-parse.ts` (moved from `codex-request.ts`).
- `system`-role messages inside `messages[]` → `developer`-role input items (applies PF-003).
- `output_config.effort` → `reasoning: { effort }` (applies PF-004). Unknown values emit `unsupported_effort_dropped` and degrade to the backend default, never 400.

**Fields that are always injected:**
- `store: false` — prevents reasoning items from persisting server-side (applies ADR-003).
- `include: ["reasoning.encrypted_content"]` — requests encrypted reasoning for cache round-trip (applies ADR-003).
- `stream: true` — always streamed internally; `aggregateFrames` reconstructs non-stream responses.
- `prompt_cache_key` — when a conversation key is derived. Drives prompt caching; 76% hit rate observed live.

### Conversation key derivation (src/conversation-key.ts)

The conversation key is a deterministic, v7-shaped UUID. Derivation: `sha256(capBytes(model) + " " + capBytes(buildInstructions(system)) + " " + capBytes(JSON.stringify(firstUserMessage)))`.

Where:
- `capBytes` truncates each component to 16 KB to bound hash cost.
- `buildInstructions(system)` is imported from `src/anthropic-parse.ts`.
- `firstUserMessage` is from the **raw inbound request** with canonical model substituted — not from builder output, which may have system-role messages translated to developer-role (PF-003).
- Returns `undefined` when no user message is present; callers fall back to `randomUUID()`.

**The model field MUST be canonical** when passed to `deriveConversationKey`. An alias and its canonical hash differently — different `session_id`, different `prompt_cache_key`, broken cache coherence and session correlation.

### session_id stability across the 401-refresh retry (src/codex-handler.ts)

`sessionId` is computed ONCE before the retry loop. Both the initial attempt and the 401-refresh retry use the same value. The retry is bounded: `maxAttempts = auth.refreshable ? 2 : 1` — a static credential gets exactly one attempt so its truthful 401 reaches the client.

## Technical Implementation Patterns

### Data flow through the Codex leg

```
IncomingMessage (Anthropic wire)
  → bufferBody (raw bytes preserved)
  → JSON.parse (once; parsedBody passed to handler — P4 contract)
  → peekModel (as-requested name for logs; never reassigned)
  → deps.resolve(model) → ModelResolution (table built once at startup in buildDeps)
  → decideRoute(method, path, resolution) → Route
  → deps.providers["codex"].handleMessages(req, res, rawBody, parsedBody, canonical)
      → AnthropicRequestSchema.safeParse(parsedBody)
      → canonical substitution (model field → canonical in `request`)
      → deriveConversationKey (hashes canonical model + system + first user msg)
      → translateRequest (codex-request.ts; ReasoningCache for reasoning re-injection)
      → buildHeaders (credentials + sessionId; bounded retry; same sessionId both attempts)
      → fetch POST /responses
      → createSseParser (chunk → SseEvent)
      → createAnthropicSseTranslator (SseEvent → Anthropic SSE frame)
      → createFrameWriter (res, signal) — real function; backpressure + abort-safe
      → stream to client (or aggregateFrames for non-streaming callers)
```

### Reasoning round-trip (src/codex-request.ts + codex-response.ts)

`include: ["reasoning.encrypted_content"]` causes the backend to emit reasoning items in `response.output_item.done` events. `createAnthropicSseTranslator` buffers these and calls `onReasoningItems(callId, items)` when a function_call item completes. `ReasoningCache` stores `callId → items[]`. On the next turn, `translateAssistantMessage` injects encrypted reasoning items before the matching `function_call` item. A cache miss emits `reasoning_cache_miss` (degraded, not broken).

`ReasoningCache` and `CodexAuthManager` are constructed inside `createCodexProvider` in `server.ts` — allocated only when a Codex provider is actually wired.

### Frame writer and abort safety (src/provider-transport.ts)

`createFrameWriter(res, signal)` is extracted into `src/provider-transport.ts` (not inline in the handler) so tests exercise the real function — a hand-copied replica in a test keeps passing after the original drifts. The already-aborted check (`signal.aborted`) is placed **after** `res.write` so an in-flight frame still goes out, but a drain-wait on an already-aborted signal resolves immediately rather than hanging forever.

## Error Handling and Recovery

| Failure | Handling |
|---|---|
| 401 before streaming begins | One credential refresh, then one retry (when `auth.refreshable`). If still 401, `auth` error returned to client. |
| Non-2xx upstream (non-401) | Error body peeked (2 KB cap), mapped to Anthropic error shape via `upstreamStatusToAnthropicError`, `retry-after` header forwarded. |
| Mid-stream upstream failure | After `message_start` is already sent, emit `toAnthropicErrorSse("api_error", …)` and close. Never retry mid-stream. |
| Abort (client close or timeout) | `AbortController` shared between `res.on("close")` and total/idle timers. Idle timer resets on each data chunk. |
| `reasoning_cache_miss` | Degraded, not broken. Warning logged as `errorCode`. |
| `maxConcurrentRequests` exceeded | 503 returned immediately; health endpoint is exempt from the concurrency gate. |

## Anti-Patterns

**Aligning `/responses` headers to `codex exec` wire captures.** The parity gaps table in `e2e/README.md` documents analytics-endpoint headers from the wrong transport (avoids PF-005). Changing `buildHeaders` to match that table will break the working `/responses` HTTP leg.

**Deriving the conversation key from builder output.** `deriveConversationKey` must receive `request` (with canonical model substitution), not the result of `translateRequest`. Builder output may have system-role messages translated to developer-role (PF-003) and the key must hash the original first user message.

**Passing an alias instead of a canonical to handleMessages.** The fifth parameter `canonicalModel` must be a resolved canonical id. Passing an alias means `deriveConversationKey` hashes the alias — the session_id and prompt_cache_key differ from a request that used the canonical directly, breaking cache coherence and session correlation.

**Moving sessionId derivation inside the retry loop.** The 401-refresh retry reuses the same `sessionId` computed before the loop. A new id per attempt breaks session correlation on the backend.

**Passing `max_tokens`/`max_output_tokens` to the Responses API.** The Codex backend returns 400 for this field. Drop it unconditionally (avoids PF-002).

**Routing before resolving.** `decideRoute` must receive a typed `ModelResolution`, never a raw string (applies ADR-005). The current signature enforces this at compile time — keep it that way.

**Omitting contested families from `byQualified`.** A family claimed by two providers must still resolve via `codex:sol`. Skipping contested entries from the qualified map makes the 400 "qualify with provider:name" remediation advice lead directly to unresolved.

## Gotchas

**`stream: true` is always sent, even when the client sets `stream: false`.** subswitch always requests an SSE stream from the backend, then `aggregateFrames` assembles a non-streaming response.

**`session_id` appears in two different places with different semantics.** In `buildHeaders`, it is a request header. In live `codex exec` analytics captures, `session_id` appears as a body field in analytics POSTs — different transport.

**`addEventListener("abort", …)` never fires on an already-aborted signal.** In `createFrameWriter`, the drain-wait loop registers an abort listener. If the signal is already aborted when a frame needs a drain wait, the listener never fires — the request's concurrency slot leaks for the life of the process, permanently degrading the server to 503. The fix is the explicit `signal.aborted` check placed after `res.write` so an in-flight frame still goes out. Any future backpressure wait must replicate this pattern.

**`Object.hasOwn` is required for alias lookup.** `buildRoutingTable` builds `byAlias` using `Object.hasOwn` during table construction; all request-time lookups are then `Map.get()` which is prototype-pollution safe. Raw bracket access on a JSON-parsed object returns inherited properties (`aliases["constructor"]` returns `Object`).

**`prompt_cache_key` is absent from `codex exec` HTTP captures.** This is correct — inference goes via WebSocket, not HTTP. The field IS valid on the `/responses` HTTP API (proved by 76% cache hit observed live 2026-07-21).

**Parallel tool calls share reasoning items.** When the backend returns multiple function calls in one response, all share the same `reasoningItems` buffer. `injectReasoningItems` deduplicates by `item.id` using `injectedReasoningIds`, but reasoning items are re-injected for each call. This is by design.

**`maxConcurrentRequests` has a failure mode where one leaked increment permanently degrades the server.** Any test must be sensitive to a single leak, not just gross breakage.

**Zod strips unknown keys.** Before `detectLegacyConfigKeys` existed, a pre-`providers.*` config would parse clean and every setting would silently revert to defaults — aliases vanished, custom baseUrl/authFile reverted, with no error or warning. The gate in `loadConfig` is the only safeguard.

## Key Files

- `src/server.ts` — Wiring site for resolve→route→send; `buildDeps` calls `buildRoutingTable` once; `deps.resolve` closure; `deps.providers[decision.provider].handleMessages` dispatch; concurrency gate
- `src/models.ts` — Pure registry module (no repo imports); `MODEL_REGISTRY`, `PROVIDER_IDS`, `buildRoutingTable`, `resolveModel`, `isReservedAnthropicName`, `formatModelsReport`, `buildModelRows`, `buildAliasRows`
- `src/router.ts` — Pure routing decision; accepts `ModelResolution` (not raw string); zero name matching; exhaustive switch
- `src/codex-handler.ts` — `handleMessages(req, res, rawBody, parsed, canonicalModel)` entry point; canonical substitution; sessionId before loop; bounded retry
- `src/provider-transport.ts` — `createFrameWriter` (abort-safe, backpressure-aware); `respondJson`, `respondProxyError`, `readBoundedText`
- `src/provider-handler.ts` — `ProviderHandler` interface; P4 contract documented
- `src/codex-request.ts` — All request translation logic; `translateRequest`, `translateEffort`
- `src/anthropic-parse.ts` — `buildInstructions` (moved from `codex-request.ts`); `textOfBlocks`
- `src/conversation-key.ts` — Deterministic v7-shaped UUID from sha256 of canonical request; imports `buildInstructions` from `anthropic-parse.ts`
- `src/codex-response.ts` — SSE parser, Anthropic SSE translator state machine, `aggregateFrames`
- `src/config.ts` — `providers.codex.*` schema; `FileConfig`/`Config` split; `resolveConfig`; `detectLegacyConfigKeys`; `AliasesSchema` refines for `isReservedAnthropicName`
- `src/logger.ts` — Closed `FIELD_KEYS` set; `cachedTokens` and `sessionKey` observability fields; log injection prevention
- `e2e/capture/codex-recorder.ts` — Dev-only transparent forwarder; excluded from npm test; NEVER commit real captures

## Related

- ADR-006 (Accepted): Source the routable set from `MODEL_REGISTRY`, not a user-maintained `codex.models` list; narrows ADR-005 (exact-membership mechanism intact and strengthened via typed `ModelResolution`)
- ADR-005 (Accepted): Route by exact model-name membership; resolution strictly before `decideRoute`; `decideRoute` now accepts `ModelResolution` (not raw string) enforcing this structurally
- ADR-001 (Superseded by ADR-005): Old prefix-matching framing; superseded; use ADR-005 for all routing citations
- ADR-002: Subscription OAuth passthrough — credentials from `~/.codex/auth.json`
- ADR-003: `store:false` encrypted reasoning round-trip; `sessionId` derived once outside retry loop
- ADR-004: `@types/node` pinned to Node-22 major
- PF-002: Drop `max_output_tokens` — backend rejects this field with 400
- PF-003: `system`-role → `developer`-role translation
- PF-004: `output_config.effort` → `reasoning.effort` propagation
- PF-005: The `e2e/README.md` parity table is the WRONG transport — do not use it to change `buildHeaders`
- PF-006: Doctor's non-zero exit is load-bearing; never assert doctor exits 0
- PF-007: Alias targets validated, not just keys — a `claude-*` target becomes routable and misroutes main-thread traffic
- `.devflow/features/cli-ux/KNOWLEDGE.md` — CLI UX layer; `subswitch models` command; doctor agent-scan; N-provider fan-out
