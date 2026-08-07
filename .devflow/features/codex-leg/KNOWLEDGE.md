---
feature: codex-leg
name: Codex translation leg (gpt-* → /responses)
description: "Use when modifying Codex request translation, model alias resolution, session/cache key derivation, protocol headers, reasoning round-trips, or the codex-recorder dev tool. Keywords: codex, gpt, responses, conversation key, session_id, prompt_cache_key, reasoning, effort, translation, routing table, alias, family, canonical, buildRoutingTable, resolveModel, ModelResolution."
category: domain-knowledge
directories: [src]
created: 2026-07-22
updated: 2026-07-28
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

Consequence: subswitch's `/responses` protocol constants were independently verified working against the HTTP backend (2026-07-21), not derived from a `codex exec` wire capture. The parity gaps table in `e2e/README.md` (Section "Parity gaps — subswitch vs real CLI") compares subswitch against analytics-endpoint headers from the wrong transport. **Do not use that table to change header names or values** in `buildHeaders` (avoids PF-005). PF-005 forbids using the wrong-transport capture table to change header **names or values**; it does **not** govern **order**.

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

**`selectFamilyWinners` is the ONLY implementation of the family selection rule.** It returns both views in one pass: `byProvider` (the per-provider partition, which `byQualified` needs so `codex:sol` resolves even when `sol` is contested) and `claims` (the collapsed per-family verdict — `unique` with the winning `ModelEntry`, or `contested` with the claimant list). `buildRoutingTable` maps `claims` to `byFamily`; `buildAliasRows`/`buildModelRows` read `flattenUniqueFamilies(claims)`. Neither side derives a winner for itself. A claim carries the winning `ModelEntry`, not its id — handing back an id forces every consumer to re-find the entry and invent a fallback for a miss that cannot happen.

**A contested family produces no derived alias row.** The router returns `ambiguous` for the bare name, so the display must not show a row claiming one provider owns it. Its members still appear as `(direct)` rows. Before this was unified, `buildFamilyMap` flattened across providers and silently arbitrated — a divergence that would have gone live the moment `PROVIDER_IDS` grew.

**`collectAliasDeclarations` is the only reader of the per-provider alias record.** It applies the `Object.hasOwn` guard, the `PROVIDER_IDS`-order-then-key-order iteration, first-provider-wins deduplication, and the PF-007 `reserved` verdict. Deduplication applies only to non-reserved keys — a reserved declaration never binds the name, so a second provider's reserved declaration of the same name is still a distinct rejection. Both the router and the display classify from this one list.

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

### Terminal block reconciliation — every provider owes a synthesized close (src/codex-response.ts)

**Provider-neutral rule: any upstream that does not emit a per-item done event MUST have its content-block closes synthesized at the terminal event, or content is silently dropped.** This is a constraint on the translator seam, not a Codex anecdote — the next provider inherits it (avoids PF-008).

The mechanism that makes it load-bearing: `aggregateFrames` materialises a content block **only** in its `content_block_stop` branch. A block that is opened and filled with deltas but never stopped contributes nothing to the assembled response. The Codex translator emits `content_block_stop` from `response.output_item.done`; `response.completed` emits `message_delta` and `message_stop` without closing anything still open. So a stream that ends without a matching done event — completed with items open, an item id or `output_index` that resolves to no block, or a truncation/abort/idle timeout after `message_start` — hands the non-streaming client **HTTP 200 with empty content** while the streaming client sees the correct text. The failure is invisible to every streaming unit test and to the streaming e2e.

A Chat Completions–style upstream has **no per-item done event at all**. Its closes must be synthesized from `finish_reason`. A translator written against such an upstream that omits this step is silently lossy on every non-streaming request, and its streaming tests will all pass.

`reconcileOpenBlocks(push)` is the single implementation. Its contract:

- **Placement is in band and non-negotiable.** It is called by the `response.completed` / `response.incomplete` handler **before** `message_delta` and `message_stop`, not from `flush()`. A streaming client that receives a `content_block_stop` after the terminal frame sees a corrupt stream. `test/unit/codex-response.test.ts` — "closes a block left open by a missing output_item.done before the terminal frames" — asserts the exact frame sequence, so moving the reconcile after `message_stop` fails the suite.
- **It returns `true` when it emitted an error frame**, meaning the caller must not emit the normal terminal frames. Callers `break` on `true`.
- **Open blocks with content get a synthesised stop; zero-delta blocks do not.** `blocksWithContent` (per-block) decides. Synthesising a stop for a block that received no delta appends a spurious empty text block; discarding it is correct.
- **A dropped delta is only fatal when nothing else landed.** `sawUnmatchedDelta && blocksWithContent.size === 0` → error frame → 502. If another block did receive content, the dropped delta degrades gracefully and the real content is returned.
- **`flush()` is the truncation path only**, reachable when no terminal lifecycle event arrived (`finished` is still false). It reconciles when some block has content, and otherwise emits an error frame if the stream had started. Guarding on `finished` is what makes a post-`message_stop` frame unreachable.

The rule in one line: **never return a healthy-looking empty turn.** An unrecoverable turn is a 502 with an error frame; a recoverable one is reconciled before the terminal frames.

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
      → buildHeaders — credential.authHeaders seed the object first; transport constants
          (openai-beta, originator, session_id, accept, content-type, user-agent) appended
          via put() guard that skips any name the credential owns, compared lowercased;
          outgoing order: authorization, chatgpt-account-id, openai-beta, originator,
          session_id, accept, content-type, user-agent; bounded retry; same sessionId both attempts
      → fetch POST /responses
      → createSseParser (chunk → SseEvent)
      → createAnthropicSseTranslator (SseEvent → Anthropic SSE frame)
          → reconcileOpenBlocks at the terminal event, BEFORE message_delta/message_stop
            (synthesised closes; error frame when nothing is recoverable)
      → createFrameWriter (res, signal) — real function; backpressure + abort-safe
      → stream to client (or aggregateFrames for non-streaming callers —
        materialises a block ONLY on its content_block_stop)
```

### Reasoning round-trip (src/codex-request.ts + codex-response.ts)

`include: ["reasoning.encrypted_content"]` causes the backend to emit reasoning items in `response.output_item.done` events. `createAnthropicSseTranslator` buffers these and calls `onReasoningItems(callId, items)` when a function_call item completes. `ReasoningCache` stores `callId → items[]`. On the next turn, `translateAssistantMessage` injects encrypted reasoning items before the matching `function_call` item. A cache miss emits `reasoning_cache_miss` (degraded, not broken).

`ReasoningCache` and `CodexAuthManager` are constructed inside `createCodexProvider` in `server.ts` — allocated only when a Codex provider is actually wired.

### Frame writer and abort safety (src/provider-transport.ts)

`createFrameWriter(res, signal)` is extracted into `src/provider-transport.ts` (not inline in the handler) so tests exercise the real function — a hand-copied replica in a test keeps passing after the original drifts. The already-aborted check (`signal.aborted`) is placed **after** `res.write` so an in-flight frame still goes out, but a drain-wait on an already-aborted signal resolves immediately rather than hanging forever.

## Error Handling and Recovery

| Failure | Handling |
|---|---|
| 401 before streaming begins | One credential refresh, then one retry (when `auth.refreshable`). If still 401, `auth` error returned to client, suffixed with `` — run `<loginCommand>` `` (sourced from `providerConfigFor(config, "codex").loginCommand`). |
| Non-2xx upstream (non-401) | Error body peeked (2 KB cap), mapped to Anthropic error shape via `upstreamStatusToAnthropicError`; credentials stripped via `redactCredentials` inside `toAnthropicErrorBody` before the text reaches the client; `retry-after` header forwarded. |
| Mid-stream upstream failure | After `message_start` is already sent, emit `toAnthropicErrorSse("api_error", …)` and close. Never retry mid-stream. |
| Stream ends with content blocks still open | `reconcileOpenBlocks` synthesises `content_block_stop` for every open block that received a delta, in band **before** `message_delta`/`message_stop`. Zero-delta blocks are discarded, not closed. Without this the non-streaming client gets a 200 with empty content (avoids PF-008). |
| Delta that matches no content block | Text is dropped. Fatal only when no block received any content — then an error frame, 502. Otherwise degrades gracefully and the placed content is returned. |
| Stream truncated before any terminal lifecycle event | `flush()` reconciles when some block has content; otherwise emits an error frame so the client gets 502, never a 200 with empty or null content. |
| Tool-use arguments non-empty but unparseable | `aggregateFrames` returns `err()` → 502. The client must not act on an invented `input: {}`. An empty argument string still yields `input: {}` — correct for a zero-argument call. |
| Abort (client close or timeout) | `AbortController` shared between `res.on("close")` and total/idle timers. Idle timer resets on each data chunk. |
| `reasoning_cache_miss` | Degraded, not broken. Warning logged as `errorCode`. |
| `maxConcurrentRequests` exceeded | 503 returned immediately; health endpoint is exempt from the concurrency gate. |

## Anti-Patterns

**Aligning `/responses` headers to `codex exec` wire captures.** The parity gaps table in `e2e/README.md` documents analytics-endpoint headers from the wrong transport (avoids PF-005). Changing `buildHeaders` to match that table will break the working `/responses` HTTP leg. PF-005 forbids using the wrong-transport capture table to change header **names or values**; it does **not** govern **order**.

**Naming `authorization` / `chatgpt-account-id` explicitly in `buildHeaders`.** Building the header object by spelling out `authorization` and `chatgpt-account-id` by name re-hardcodes one provider's header names into a provider-neutral handler. Any provider whose credential returns `x-api-key` or `{}` instead of those names would have its auth headers silently dropped, leaving the request unauthenticated. Credentials supply their own names via `authHeaders`; `buildHeaders` must not know what those names are — the `put()` guard writes transport constants and the credential's own entries land first.

**Writing a provider translator with no terminal reconciliation.** Any upstream lacking a per-item done event needs its content-block closes synthesized at the terminal event — a Chat Completions–style upstream must synthesize them from `finish_reason` (avoids PF-008). Omitting this is silently lossy on every non-streaming request while the whole streaming test suite stays green, because `aggregateFrames` materialises a block only on its `content_block_stop`.

**Moving `reconcileOpenBlocks` out of the terminal handler and into `flush()`.** The synthesised closes must be emitted in band, before `message_delta` and `message_stop`. A `content_block_stop` that lands after the terminal frame is a corrupt stream to a streaming client. This was the shape of the first fix and it is pinned by "closes a block left open by a missing output_item.done before the terminal frames" in `test/unit/codex-response.test.ts`. `flush()` is the truncation path only, guarded on `finished`.

**Synthesising a close for every open block.** Only blocks in `blocksWithContent` get a stop; a block that received zero deltas is discarded. Closing it appends a spurious empty text block to the assembled response — a different way to lie about what the upstream produced.

**Deriving the conversation key from builder output.** `deriveConversationKey` must receive `request` (with canonical model substitution), not the result of `translateRequest`. Builder output may have system-role messages translated to developer-role (PF-003) and the key must hash the original first user message.

**Passing an alias instead of a canonical to handleMessages.** The fifth parameter `canonicalModel` must be a resolved canonical id. Passing an alias means `deriveConversationKey` hashes the alias — the session_id and prompt_cache_key differ from a request that used the canonical directly, breaking cache coherence and session correlation.

**Moving sessionId derivation inside the retry loop.** The 401-refresh retry reuses the same `sessionId` computed before the loop. A new id per attempt breaks session correlation on the backend.

**Passing `max_tokens`/`max_output_tokens` to the Responses API.** The Codex backend returns 400 for this field. Drop it unconditionally (avoids PF-002).

**Routing before resolving.** `decideRoute` must receive a typed `ModelResolution`, never a raw string (applies ADR-005). The current signature enforces this at compile time — keep it that way.

**Omitting contested families from `byQualified`.** A family claimed by two providers must still resolve via `codex:sol`. Skipping contested entries from the qualified map makes the 400 "qualify with provider:name" remediation advice lead directly to unresolved.

**Re-deriving a family winner anywhere outside `selectFamilyWinners`.** Any second loop that walks the registry picking a highest-`gen` entry is a copy of the rule and will drift — that is exactly what `buildFamilyMap` was. Consume `claims` or `flattenUniqueFamilies(claims)`. `test/unit/routing-table.test.ts` D-T1 exists to catch this: it fails the moment the display flattens across providers on its own.

**Falling back to `PROVIDER_IDS[0]` for an unknown provider.** The declaring provider is always in hand — `collectAliasDeclarations` carries it, matching the router's `byId.get(target) ?? provider`. A first-provider assumption is correct only by coincidence while `PROVIDER_IDS.length === 1`, and no test can distinguish the two until a second provider lands.

**Regenerating `test/fixtures/sse-splits.golden.json` to make a parser change pass.** The golden was captured from the parser as it stood *before* the deferred-join rewrite and is the definition of "frame boundaries unchanged". A `createSseParser` change that needs a new golden has changed the one thing the golden exists to forbid. Regenerate it only when the corpus itself grows (`node --import tsx test/tools/gen-sse-splits-golden.ts`), and review every changed frame sequence as a behaviour claim.

**Joining the SSE accumulator outside the boundary branch.** `createSseParser` holds undelivered text as an array of segments and joins only on the chunk that completes an event. Adding a `pending.join("")` on the no-boundary path restores the quadratic `buffer += chunk` behaviour — 38x slower at 8 MiB — while every test stays green. Verified by mutation, not assumed.

## Gotchas

**`stream: true` is always sent, even when the client sets `stream: false`.** subswitch always requests an SSE stream from the backend, then `aggregateFrames` assembles a non-streaming response.

**`session_id` appears in two different places with different semantics.** In `buildHeaders`, it is a request header. In live `codex exec` analytics captures, `session_id` appears as a body field in analytics POSTs — different transport.

**`addEventListener("abort", …)` never fires on an already-aborted signal.** In `createFrameWriter`, the drain-wait loop registers an abort listener. If the signal is already aborted when a frame needs a drain wait, the listener never fires — the request's concurrency slot leaks for the life of the process, permanently degrading the server to 503. The fix is the explicit `signal.aborted` check placed after `res.write` so an in-flight frame still goes out. Any future backpressure wait must replicate this pattern.

**`Object.hasOwn` is required for alias lookup.** `buildRoutingTable` builds `byAlias` using `Object.hasOwn` during table construction; all request-time lookups are then `Map.get()` which is prototype-pollution safe. Raw bracket access on a JSON-parsed object returns inherited properties (`aliases["constructor"]` returns `Object`).

**`prompt_cache_key` is absent from `codex exec` HTTP captures.** This is correct — inference goes via WebSocket, not HTTP. The field IS valid on the `/responses` HTTP API (proved by 76% cache hit observed live 2026-07-21).

**Parallel tool calls share reasoning items.** When the backend returns multiple function calls in one response, all share the same `reasoningItems` buffer. `injectReasoningItems` deduplicates by `item.id` using `injectedReasoningIds`, but reasoning items are re-injected for each call. This is by design.

**`maxConcurrentRequests` has a failure mode where one leaked increment permanently degrades the server.** Any test must be sensitive to a single leak, not just gross breakage.

**Zod strips unknown keys.** Before `detectLegacyConfigKeys` existed, a pre-`providers.*` config would parse clean and every setting would silently revert to defaults — aliases vanished, custom baseUrl/authFile reverted, with no error or warning. The gate in `loadConfig` is the only safeguard.

**No test in the suite can catch an SSE-parser performance regression.** The slow path is byte-for-byte correct, so it passes all 66,066 golden split assertions and the whole suite. `node --import tsx test/tools/sse-parser.bench.ts` is the only artifact that distinguishes them — run it after any `createSseParser` edit. Reference at 8 KiB chunks, one oversized event: 4.7 ms / 6.9 ms / 14.7 ms at 2 / 4 / 8 MiB. Roughly 2x per doubling is correct; roughly 4x means the join moved.

**`maxSseEventBytes` counts UTF-16 code units, not bytes, despite the name.** Preserved deliberately through the parser rewrite — changing it to byte length moves the trip point for multi-byte payloads and is a separate decision. The check runs per chunk against the undelivered residual, so it bounds live memory; a version that checks after assembling the event still reports `sse_event_too_large` but is no longer a memory control, and only a test counting chunks accepted before rejection can tell the two apart.

**`codex-recorder.ts` cannot capture SSE events from the live backend.** Its detection gates on `contentType.includes("text/event-stream")`, but the production `/responses` stream sends **no `Content-Type` header at all**. The recorder therefore silently degrades to pass-through mode, capturing no events and no `usage`. It works correctly only against local fixture upstreams, which do set the header. A one-line `|| contentType === ""` relaxation in the content-type check fixes it. Anyone repeating the live-capture protocol with the checked-in recorder will get empty event captures and may wrongly conclude the stream is broken. (See also CHANGELOG known limitations.)

## Key Files

- `src/server.ts` — Wiring site for resolve→route→send; `buildDeps` calls `buildRoutingTable` once; `deps.resolve` closure; `deps.providers[decision.provider].handleMessages` dispatch; concurrency gate
- `src/models.ts` — Pure registry module (no repo imports); `MODEL_REGISTRY`, `PROVIDER_IDS`, `buildRoutingTable`, `resolveModel`, `isReservedAnthropicName`, `formatModelsReport`, `buildModelRows`, `buildAliasRows`. Private and load-bearing: `compareGen` (the numeric comparator), `selectFamilyWinners` (THE family rule, one implementation), `flattenUniqueFamilies`, `collectAliasDeclarations`
- `src/router.ts` — Pure routing decision; accepts `ModelResolution` (not raw string); zero name matching; exhaustive switch
- `src/codex-handler.ts` — `handleMessages(req, res, rawBody, parsed, canonicalModel)` entry point; canonical substitution; sessionId before loop; bounded retry
- `src/provider-transport.ts` — `createFrameWriter` (abort-safe, backpressure-aware); `respondJson`, `respondProxyError`, `readBoundedText`
- `src/provider-handler.ts` — `ProviderHandler` interface; P4 contract documented
- `src/codex-request.ts` — All request translation logic; `translateRequest`, `translateEffort`
- `src/anthropic-parse.ts` — `buildInstructions` (moved from `codex-request.ts`); `textOfBlocks`
- `src/conversation-key.ts` — Deterministic v7-shaped UUID from sha256 of canonical request; imports `buildInstructions` from `anthropic-parse.ts`
- `src/codex-response.ts` — SSE parser (segment array + 3-char carry, joins only on a completing chunk; linear, not quadratic), Anthropic SSE translator state machine, `aggregateFrames`
- `test/tools/` — Typechecked but outside the `npm test` globs: `sse-parser.bench.ts` (the only guard against an SSE-parser perf regression), `sse-split-corpus.ts`, `gen-sse-splits-golden.ts`
- `test/fixtures/sse-splits.golden.json` — Frame-boundary pin for `createSseParser`, captured pre-rewrite; 16,269 two-way + 49,770 three-way splits asserted by `test/unit/sse-split-golden.test.ts`
- `src/config.ts` — `providers.codex.*` schema; `FileConfig`/`Config` split; `resolveConfig`; `detectLegacyConfigKeys`; `AliasesSchema` refines for `isReservedAnthropicName`
- `src/logger.ts` — Closed `FIELD_KEYS` set; `cachedTokens` and `sessionKey` observability fields; log injection prevention
- `e2e/capture/codex-recorder.ts` — Dev-only transparent forwarder; excluded from npm test; NEVER commit real captures. **Known defect**: cannot capture SSE from the live backend (no `Content-Type` header on production `/responses` stream); see Gotchas.

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
- PF-005: The `e2e/README.md` parity table is the WRONG transport — do not use it to change header **names or values** in `buildHeaders`; it does **not** govern header **order**
- PF-006: Doctor's non-zero exit is load-bearing; never assert doctor exits 0
- PF-007: Alias targets validated, not just keys — a `claude-*` target becomes routable and misroutes main-thread traffic
- PF-008: An upstream without a per-item done event needs a synthesized close, or `aggregateFrames` returns a 200 with empty content
- `.devflow/features/cli-ux/KNOWLEDGE.md` — CLI UX layer; `subswitch models` command; doctor agent-scan; N-provider fan-out
