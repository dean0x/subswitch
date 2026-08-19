---
feature: codex-leg
name: Codex translation leg (gpt-* → /responses)
description: "Use when modifying Codex request translation, model alias resolution, session/cache key derivation, protocol headers, reasoning round-trips, count_tokens estimation, ambiguous-model routing policy, timeout asymmetry, or the codex-recorder dev tool. Keywords: codex, gpt, responses, conversation key, session_id, prompt_cache_key, reasoning, effort, translation, routing table, alias, family, canonical, buildRoutingTable, resolveModel, ModelResolution, buildHeaders, CodexTransportConstants, maxAggregateBytes, forceRefresh, count_tokens, estimateTokens, ambiguous_model_name, BufferBodyError, ADR-010, streamIdleTimeoutMs."
category: domain-knowledge
directories: [src]
created: 2026-07-22
updated: 2026-08-19
---

# Codex Translation Leg (gpt-* → /responses)

## Overview

subswitch translates Anthropic Messages API requests into OpenAI Responses API calls against `https://chatgpt.com/backend-api/codex/responses`. Routing is decided by `resolveModel` (in `src/models.ts`) and `decideRoute` (in `src/router.ts`), with `MODEL_REGISTRY` as the sole source of routable models (applies ADR-006). Everything else passes through to the Anthropic leg unchanged.

The pipeline has three distinct stages: **resolve** (alias/family → canonical model in `server.ts`), **route** (dispatch decision in `router.ts`), and **send** (translation + fetch in `codex-handler.ts`). Keeping these stages separate is the load-bearing invariant of ADR-005 — the router accepts a typed `ModelResolution`, never a raw string, so name matching cannot creep back in.

**Governing principle (ADR-010):** a relay fronting an origin API must be indistinguishable from the origin. A bound that reclaims a provably dead connection is legitimate; a bound that can terminate a request the origin was about to answer, or emit a status the origin never sends, is a defect. This principle drove the removal of the byte-budget slot system and the **removal** (not deprecation) of the Anthropic-leg stream timeout.

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

**`collectAliasDeclarations` is the only reader of the per-provider alias record.** It applies the `Object.hasOwn` guard, the `PROVIDER_IDS`-order-then-key-order iteration, first-provider-wins deduplication, and the PF-007 `reserved` verdict. Deduplication applies only to non-reserved keys — a reserved declaration never binds the name, so a second provider's reserved declaration of the same name is still a distinct rejection. Both the router and the display classify from this one list.

**`preview: true`** entries are excluded from `byFamily` but resolvable by exact id. **`retired: true`** entries are excluded from `byFamily` and from qualified-family lookups, but resolvable by exact id and by `"provider:id"` qualified lookup.

**`isReservedAnthropicName` (renamed from `isAnthropicModelName`; regex unchanged).** Prefix-based, covering `inherit|sonnet|opus|haiku|claude-*`. Used in two places that must never disagree:
- `config.ts` AliasesSchema refines — reject alias keys or values at config-parse time.
- `buildRoutingTable` `byAlias` construction — entries matching the predicate are added to `rejectedAliases` and skipped.

### Ambiguous Model Policy: Fail Open (src/server.ts)

When `decideRoute` returns `{ kind: "ambiguous" }`, the server **forwards to Anthropic** rather than synthesizing a 400. This is ADR-010 applied to routing: a relay-invented 400 that names our provider registry in the error message is a status the origin never emits. The origin may support the name unambiguously; at minimum, forwarding lets it answer with its own error.

`Route.ambiguous` is **kept** in the router. Classification (what the name is) lives in the router; policy (what to do with it) lives in the server. The `server.ts` comment makes this distinction explicit so the two are not collapsed.

The `ambiguous_model_name` warn log preserves diagnostic value: the `model` field carries the ambiguous name annotated with the provider list (`"name (p1, p2)"`).

**Doctor severity:** `unknown_provider` is `"info"` (the request still forwards and may succeed at the origin); `ambiguous` stays `"fail"` because that conflict is subswitch-derived and WILL 404 at the origin — flagging it is honest.

### count_tokens Returns an Estimate (src/codex-handler.ts + src/codex-request.ts)

`handleCountTokens` returns `{ input_tokens: estimateTokens(rawBody) }` where `estimateTokens` uses a `chars / 4` heuristic (UTF-16 code units, not bytes). This is a **deliberate design decision, not an unfinished shortcut.**

Rationale: forwarding the count_tokens request to Anthropic would return a count for a different model (Claude's tokenizer, not the Codex model). The chars/4 estimate is the least-wrong option — close enough for Claude Code's context bookkeeping purposes without misattributing a different model's count. Do not "fix" this by forwarding to Anthropic.

### Resolve → Route → Send in src/server.ts

The body is JSON-parsed **once** in `server.ts`. The parsed value (`parsedBody`) is passed to the provider handler so it never needs to call `JSON.parse` again (P4 contract).

`route` log field format: `"provider:endpoint:model"` (e.g., `"codex:messages:gpt-5.6-sol"`). `model` in the log is always the as-requested name — a typo still logs `model=sool`.

### Canonical threading through handleMessages (src/codex-handler.ts)

`handleMessages` signature: `(req, res, rawBody, parsed, canonicalModel)`. The canonical model is threaded because `deriveConversationKey` hashes the model string — an alias and its canonical produce DIFFERENT `session_id` and `prompt_cache_key` without substitution.

`model` is NEVER reassigned — all log calls use the as-requested name. `request` (with canonical model) is passed to `deriveConversationKey` and `translateRequest`.

### buildHeaders — exported module-level pure function (src/codex-handler.ts)

`buildHeaders<P extends ProviderId>(credential, sessionId, transportConstants)` is an **exported, module-level pure function** — not a closure. It has no side effects and no closure captures. The `CodexTransportConstants` interface holds the non-credential, non-session transport headers (`openai-beta`, `originator`, `accept`, `content-type`, `user-agent`); the instance is built once per handler in `createCodexHandler` and passed to `buildHeaders` per request.

Credential headers land first so auth appears before transport constants on the wire. The `put()` guard lowercases both sides of the owned-Set check so a credential returning `"User-Agent"` (capital) and our `put("user-agent", …)` are correctly identified as the same name — exactly one key is emitted and the credential wins.

**`createCodexHandler<P>` returns `ProviderHandler` directly.** The old `CodexHandler` interface has been deleted; the function's return type is `ProviderHandler`.

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

**`AbortController` is constructed ABOVE `auth.getCredentials()`** (RELI-04). Without this, a hung `getCredentials()` (e.g., a single-flight refresh on a slow OAuth endpoint) runs outside every bound the handler establishes: the client-close signal is not wired up, the total timer has not started, and cleanup never runs if `getCredentials()` returns an error.

### Terminal block reconciliation — every provider owes a synthesized close (src/codex-response.ts)

**Provider-neutral rule: any upstream that does not emit a per-item done event MUST have its content-block closes synthesized at the terminal event, or content is silently dropped.** This is a constraint on the translator seam, not a Codex anecdote — the next provider inherits it (avoids PF-008).

`reconcileOpenBlocks(push)` is the single implementation. Its contract:

- **Placement is in band and non-negotiable.** It is called by the `response.completed` / `response.incomplete` handler **before** `message_delta` and `message_stop`, not from `flush()`. A streaming client that receives a `content_block_stop` after the terminal frame sees a corrupt stream.
- **It returns `true` when it emitted an error frame**, meaning the caller must not emit the normal terminal frames. Callers `break` on `true`.
- **Open blocks with content get a synthesised stop; zero-delta blocks do not.** `blocksWithContent` (per-block) decides.
- **A dropped delta is only fatal when nothing else landed.** `sawUnmatchedDelta && blocksWithContent.size === 0` → error frame → 502. If another block did receive content, the dropped delta degrades gracefully.
- **`flush()` is the truncation path only**, reachable when no terminal lifecycle event arrived (`finished` is still false). When at least one block has content, `flush()` now calls `reconcileOpenBlocks` and then emits `message_delta` (`stop_reason: "max_tokens"`) + `message_stop`, so no leg sees a turn without a terminal frame (avoids PF-008). If nothing was recoverable and the stream had started, it emits an error frame.

**`MAX_CONTENT_BLOCKS = 1024`** caps the number of blocks `createAnthropicSseTranslator` will register (RELI-03). `blockIndexByKey` is intentionally **NOT pruned** on `content_block_stop` — a late delta for a closed block would otherwise become `sawUnmatchedDelta`, risking a spurious 502 from `reconcileOpenBlocks` when the turn is otherwise healthy.

The rule in one line: **never return a healthy-looking empty turn.** An unrecoverable turn is a 502 with an error frame; a recoverable one is reconciled before the terminal frames.

### Auth credential management (src/codex-auth.ts)

`CodexAuthManager` now accepts `events: ProviderEvents<"codex">` in its constructor options. **All seven auth event names are now table-derived** from this record — the same compile-time guarantee as the handler and translator events. The previously-documented "known gap" (six hardcoded `codex_*` literals in `codex-auth.ts`) is closed.

The seven auth events now in `ProviderEvents<P>`: `tokenRefreshed`, `refreshTokenRotatedExternally`, `tokenRefreshFailed`, `refreshRetryBoundViolated`, `authFileNewerThanRefresh`, `authFileWriteFailed`, `authFileUnreadableAfterRefresh`.

**`callTokenEndpoint` passes `AbortSignal.timeout(15_000)`.** Without a timeout, a hung OAuth server holds the single-flight promise open indefinitely, blocking every pending request that shares the one `refreshInflight` promise until it resolves or the 15 s signal fires.

**`forceRefresh()` has a 30-second cooldown** (`FORCE_REFRESH_COOLDOWN_MS = 30_000`). A persistent upstream 401 that survives a freshly-minted token must not trigger a full OAuth round-trip on every concurrent request.

**The auth-file temp write self-heals one `EEXIST`.** `writeAtomic` opens the temp file with `O_EXCL` (exclusive create). On `EEXIST` (stale temp from a prior crashed run), it unlinks the stale file and retries once — a bounded single-retry, not a loop.

## Technical Implementation Patterns

### Data flow through the Codex leg

```
IncomingMessage (Anthropic wire)
  → bufferBody (raw bytes preserved; body_too_large → 413; client_disconnected → drop)
  → JSON.parse (once; parsedBody passed to handler — P4 contract)
  → peekModel (as-requested name for logs; never reassigned)
  → deps.resolve(model) → ModelResolution (table built once at startup in buildDeps)
  → decideRoute(method, path, resolution) → Route
      ├── "ambiguous" → warn ambiguous_model_name; forward to Anthropic (fail open, ADR-010)
      ├── "unknown_provider" → warn unknown_provider_qualifier; forward to Anthropic
      └── "provider" → dispatch to handleMessages or handleCountTokens
  → deps.providers["codex"].handleMessages(req, res, rawBody, parsedBody, canonical)
      → AnthropicRequestSchema.safeParse(parsedBody)
      → canonical substitution (model field → canonical in `request`)
      → deriveConversationKey (hashes canonical model + system + first user msg)
      → AbortController constructed (BEFORE auth.getCredentials — RELI-04)
      → auth.getCredentials() → ProviderCredential<"codex">
      → translateRequest (codex-request.ts; ReasoningCache for reasoning re-injection)
      → buildHeaders(credential, sessionId, transportConstants)
          ← transportConstants built once per handler instance; pure module-level fn
          ← credential.authHeaders seed; put() guard lowercased; transport constants appended
          ← outgoing order: authorization, chatgpt-account-id, openai-beta, originator,
             session_id, accept, content-type, user-agent; same sessionId both attempts
      → fetch POST /responses (controller.signal; 401 refresh bounded; forceRefresh 30s cooldown)
      → createSseParser (chunk → SseEvent)
      → createAnthropicSseTranslator (SseEvent → Anthropic SSE frame)
          → MAX_CONTENT_BLOCKS cap; blockIndexByKey NOT pruned on content_block_stop
          → reconcileOpenBlocks at the terminal event, BEFORE message_delta/message_stop
          → flush() emits message_delta(max_tokens)+message_stop when content exists
      → createFrameWriter (res, signal) — real function; backpressure + abort-safe
      → stream to client (or aggregateFrames for non-streaming — materialises a block
        ONLY on its content_block_stop; bounded by maxAggregateBytes=64MiB)

  → handleCountTokens: estimateTokens(rawBody) → chars/4 heuristic → { input_tokens: N }
        (deliberate estimate — forwarding to Anthropic would return a different model's count)
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
| Stream truncated before any terminal lifecycle event | `flush()` reconciles when some block has content and emits `message_delta(max_tokens)` + `message_stop`; otherwise emits an error frame so the client gets 502, never a 200 with empty or null content. |
| Non-streaming accumulation exceeds `maxAggregateBytes` (64 MiB) | 502 "stream interrupted" — same shape as any other pipeline failure on this leg. Never pass a truncated frames array to `aggregateFrames` (would silently produce 200 with empty content — avoids PF-008). |
| Tool-use arguments non-empty but unparseable | `aggregateFrames` returns `err()` → 502. The client must not act on an invented `input: {}`. An empty argument string still yields `input: {}` — correct for a zero-argument call. |
| Codex-leg timeout | 504 with `api_error` — **kept deliberately** (ADR-010: 504 is a status the origin genuinely produces for a timed-out upstream; the relay must not invent an alternative). |
| Unrepresentable upstream status | 502 with `api_error` — **kept deliberately** (ADR-010: same rationale; the upstream produced a status, and 502 is the truthful relay response). |
| Abort (client close or timeout) | `AbortController` shared between `res.on("close")` and total/idle timers. Idle timer resets on each data chunk. |
| `reasoning_cache_miss` | Degraded, not broken. Warning logged as `errorCode`. |
| `body_too_large` | 413 with `request_too_large`. `drainRejectedUpload()` lets remaining upload drain via FIN rather than RST. `body_too_large` is a **server-local `BufferBodyError`** — deliberately excluded from `ProxyError` so `proxyErrorToAnthropic` can never be called with it. |
| `client_disconnected` | Client is gone — no HTTP response sent. Also a `BufferBodyError`, not a `ProxyError`. |

## Anti-Patterns

**Aligning `/responses` headers to `codex exec` wire captures.** The parity gaps table in `e2e/README.md` documents analytics-endpoint headers from the wrong transport (avoids PF-005). Changing `buildHeaders` to match that table will break the working `/responses` HTTP leg. PF-005 forbids using the wrong-transport capture table to change header **names or values**; it does **not** govern header **order**.

**Naming `authorization` / `chatgpt-account-id` explicitly in `buildHeaders`.** Building the header object by spelling out `authorization` and `chatgpt-account-id` by name re-hardcodes one provider's header names into a provider-neutral handler. Credentials supply their own names via `authHeaders`; `buildHeaders` must not know what those names are — the `put()` guard writes transport constants and the credential's own entries land first.

**Writing a provider translator with no terminal reconciliation.** Any upstream lacking a per-item done event needs its content-block closes synthesized at the terminal event — a Chat Completions–style upstream must synthesize them from `finish_reason` (avoids PF-008). Omitting this is silently lossy on every non-streaming request while the whole streaming test suite stays green.

**Moving `reconcileOpenBlocks` out of the terminal handler and into `flush()`.** The synthesised closes must be emitted in band, before `message_delta` and `message_stop`. `flush()` is the truncation path only, guarded on `finished`.

**Synthesising a close for every open block.** Only blocks in `blocksWithContent` get a stop; a block that received zero deltas is discarded. Closing it appends a spurious empty text block to the assembled response.

**Pruning `blockIndexByKey` on `content_block_stop`.** A late delta for a closed block would then become `sawUnmatchedDelta`. If no other block received content, this triggers a spurious 502 from `reconcileOpenBlocks`. The map is bounded by `MAX_CONTENT_BLOCKS` instead.

**Deriving the conversation key from builder output.** `deriveConversationKey` must receive `request` (with canonical model substitution), not the result of `translateRequest`. Builder output may have system-role messages translated to developer-role (PF-003).

**Passing an alias instead of a canonical to handleMessages.** The fifth parameter `canonicalModel` must be a resolved canonical id. Passing an alias means `deriveConversationKey` hashes the alias — breaking cache coherence and session correlation.

**Moving sessionId derivation inside the retry loop.** The 401-refresh retry reuses the same `sessionId` computed before the loop. A new id per attempt breaks session correlation on the backend.

**Passing `max_tokens`/`max_output_tokens` to the Responses API.** The Codex backend returns 400 for this field. Drop it unconditionally (avoids PF-002).

**Routing before resolving.** `decideRoute` must receive a typed `ModelResolution`, never a raw string (applies ADR-005).

**Omitting contested families from `byQualified`.** A family claimed by two providers must still resolve via `codex:sol`.

**Re-deriving a family winner anywhere outside `selectFamilyWinners`.** Consume `claims` or `flattenUniqueFamilies(claims)`.

**Falling back to `PROVIDER_IDS[0]` for an unknown provider.** The declaring provider is always in hand — `collectAliasDeclarations` carries it. A first-provider assumption is correct only by coincidence while `PROVIDER_IDS.length === 1`.

**Regenerating `test/fixtures/sse-splits.golden.json` to make a parser change pass.** The golden was captured from the parser before the deferred-join rewrite and is the definition of "frame boundaries unchanged". Regenerate it only when the corpus itself grows.

**Joining the SSE accumulator outside the boundary branch.** `createSseParser` holds undelivered text as an array of segments and joins only on the chunk that completes an event. Adding a `pending.join("")` on the no-boundary path restores the quadratic behaviour — 38x slower at 8 MiB.

**"Fixing" count_tokens by forwarding to Anthropic.** The estimate is deliberate: Anthropic returns counts for Claude's tokenizer, not for the Codex model. The chars/4 heuristic is correct; forwarding is wrong.

**Synthesizing a 400/429/503 for an ambiguous model name.** The policy is fail open (ADR-010). A relay-invented 400 naming our registry is a status the origin never emits. `Route.ambiguous` stays in the router for classification; the server decides the policy.

## Gotchas

**`stream: true` is always sent, even when the client sets `stream: false`.** subswitch always requests an SSE stream from the backend, then `aggregateFrames` assembles a non-streaming response.

**`session_id` appears in two different places with different semantics.** In `buildHeaders`, it is a request header. In live `codex exec` analytics captures, `session_id` appears as a body field in analytics POSTs — different transport.

**`blockIndexByKey` is NOT pruned on `content_block_stop` — this is intentional.** A late delta for a closed block (which can arrive if the upstream reorders events) would be classified as `sawUnmatchedDelta` if the key were pruned. With no other block receiving content, that triggers a spurious 502. The map is bounded by `MAX_CONTENT_BLOCKS = 1024` instead.

**`subswitch.config.example.json` must stay in sync with the strict schema.** After `CodexProviderSchema`, `AnthropicSchema`, `LimitsSchema`, and `FileConfigSchema` became `z.strictObject`, an unknown key in the example file is a hard load error, not a cosmetic drift. Anyone updating the schema must update the example file.

**`addEventListener("abort", …)` never fires on an already-aborted signal.** In `createFrameWriter`, the drain-wait loop registers an abort listener. If the signal is already aborted when a frame needs a drain wait, the listener never fires — the request hangs forever. The fix is the explicit `signal.aborted` check placed after `res.write` so an in-flight frame still goes out. Any future backpressure wait must replicate this pattern.

**`Object.hasOwn` is required for alias lookup.** `buildRoutingTable` builds `byAlias` using `Object.hasOwn` during table construction; all request-time lookups are then `Map.get()` which is prototype-pollution safe.

**`prompt_cache_key` is absent from `codex exec` HTTP captures.** This is correct — inference goes via WebSocket, not HTTP. The field IS valid on the `/responses` HTTP API (proved by 76% cache hit observed live 2026-07-21).

**`maxSseEventBytes` counts UTF-16 code units, not bytes, despite the name.** The check runs per chunk against the undelivered residual, bounding accumulated text length; segment-array object and header overhead is uncounted, so actual heap can exceed the limit significantly at per-byte-chunk scale (roughly 96 MiB uncounted at the 4 MiB default with 1-byte chunks).

**`MIN_COMPACT_CHARS` compaction ADDS copying — that is the accepted cost.** Compaction's actual payoff is bounding segment-array overhead in the small-chunk case: a 1 MiB event arriving in 1-byte chunks would build ~1M segments without it; with it the peak is halved. The copy overhead is linear (+50%/+20%/+23% at 2/4/8 MiB). A fixed-count trigger would reintroduce O(n²/N) and must be rejected.

**Parallel tool calls share reasoning items.** When the backend returns multiple function calls in one response, all share the same `reasoningItems` buffer. `injectReasoningItems` deduplicates by `item.id` using `injectedReasoningIds`, but reasoning items are re-injected for each call. This is by design.

**No test in the suite can catch an SSE-parser performance regression.** The slow path is byte-for-byte correct, so it passes all golden split assertions. `node --import tsx test/tools/sse-parser.bench.ts` is the only artifact that distinguishes them — run it after any `createSseParser` edit.

**`codex-recorder.ts` cannot capture SSE events from the live backend.** Its detection gates on `contentType.includes("text/event-stream")`, but the production `/responses` stream sends **no `Content-Type` header at all** (avoids PF-013). The recorder therefore silently degrades to pass-through mode. It works correctly only against local fixture upstreams.

**The Codex leg has a stream idle timeout; the Anthropic leg does not — this is a genuine asymmetry.** `providers.codex.streamIdleTimeoutMs` is live and intentional (default 300 s). The Anthropic leg has no post-connect timer at all by design (ADR-010): `connectTimeoutMs` bounds DNS+TCP establishment only. `anthropic.streamIdleTimeoutMs` was **removed** in 0.3.0 — it is a `removed`-kind row in `LEGACY_KEY_ENTRIES` and `loadConfig` returns `err` (the relay refuses to start) if it appears in config. `anthropic.headerTimeoutMs` was never shipped and is not in `LEGACY_KEY_ENTRIES`; it is rejected by `z.strictObject` as an unrecognised field. `LEGACY_KEY_ENTRIES` has a `moved` row migrating `limits.streamIdleTimeoutMs` → `providers.codex.streamIdleTimeoutMs`; there is no Anthropic equivalent. Any code that assumes both legs have matching timeout behavior is wrong.

**Pooled outbound sockets already carry OS-level TCP keepalive.** The outbound `http.Agent` is constructed with `{ keepAlive: true, … }`, which causes Node to enable TCP keepalive (1 s initial delay) on every socket it pools. No explicit `setKeepAlive()` call is needed or present.

**Test suite must run alone; globs are flat and non-recursive.** Test globs are `test/unit/*.test.ts` and `test/integration/*.test.ts` — they do NOT descend into subdirectories. The suite has a hard 30 s per-test timeout and no fake timers. Wall-clock assertions flake when run alongside parallel processes (e.g. `tsc`). Always run the suite alone when validating timing-sensitive behavior.

## Key Files

- `src/server.ts` — Wiring site for resolve→route→send; `buildDeps` calls `buildRoutingTable` once; `deps.resolve` closure; `deps.providers[decision.provider].handleMessages` dispatch; ambiguous fail-open policy; `BufferBodyError` (server-local, not `ProxyError`); `applyInboundPolicy` (from `src/inbound-policy.ts`) owns `SERVER_TUNING` + `clientError` handler
- `src/models.ts` — Pure registry module (no repo imports); `MODEL_REGISTRY`, `PROVIDER_IDS`, `AliasesByProvider`, `buildRoutingTable`, `resolveModel`, `isReservedAnthropicName`, `routableModelCount`, `formatModelsReport`, `buildModelRows`, `buildAliasRows`
- `src/router.ts` — Pure routing decision; accepts `ModelResolution` (not raw string); zero name matching; exhaustive switch; classification only — policy lives in server.ts
- `src/codex-handler.ts` — `createCodexHandler<P>(deps): ProviderHandler` entry point; `CodexHandlerDeps<P>`, `CodexTransportConstants` interface; `buildHeaders` (exported pure module-level fn); canonical substitution; sessionId before loop; bounded retry; `AbortController` above `auth.getCredentials()`; `handleCountTokens` (estimate, not forwarded)
- `src/provider-transport.ts` — `createFrameWriter` (abort-safe, backpressure-aware); `respondJson`, `respondProxyError`, `readBoundedText`
- `src/provider-handler.ts` — `ProviderHandler` interface; P4 contract documented
- `src/codex-request.ts` — All request translation logic; `translateRequest`, `translateEffort`, `estimateTokens` (chars/4 heuristic)
- `src/anthropic-parse.ts` — `buildInstructions` (moved from `codex-request.ts`); `textOfBlocks`
- `src/conversation-key.ts` — Deterministic v7-shaped UUID from sha256 of canonical request
- `src/codex-response.ts` — `MAX_CONTENT_BLOCKS`; SSE parser (segment array; linear); Anthropic SSE translator state machine; `aggregateFrames`; `blockIndexByKey` NOT pruned on stop
- `src/codex-auth.ts` — `CodexAuthManager`; all 7 auth events now table-derived via `events: ProviderEvents<"codex">`; `callTokenEndpoint` uses `AbortSignal.timeout(15_000)`; `forceRefresh()` 30s cooldown; `writeAtomic` self-heals EEXIST
- `src/provider-events.ts` — `providerEvents<P>(id): ProviderEvents<P>`; 19-field table (11 handler/translator events + 1 insecureBaseUrlScheme + 7 auth events); compile-time log-injection control
- `src/config.ts` — `providers.codex.streamIdleTimeoutMs` (default 300 s, live); `anthropic.streamIdleTimeoutMs` removed in 0.3.0 (ADR-010) — `removed`-kind row in `LEGACY_KEY_ENTRIES`, hard-errors on load; `anthropic.headerTimeoutMs` never shipped — rejected by `z.strictObject`, not in table; `LEGACY_KEY_ENTRIES` has a `moved` row for `limits.streamIdleTimeoutMs` → `providers.codex.streamIdleTimeoutMs`; `providers.codex.maxAggregateBytes` (64 MiB default); strict schemas via `z.strictObject`
- `src/errors.ts` — `ProxyError` union (auth/upstream/translate/timeout); `BufferBodyError` is separate and local to `server.ts`; `AnthropicErrorType` includes `not_found_error`; `upstreamStatusToAnthropicError`; 504→timeout and 502→upstream are both intentional (ADR-010)
- `src/agent-scan.ts` — `unknown_provider` severity is `"info"`; `ambiguous` severity is `"fail"`
- `test/tools/` — `sse-parser.bench.ts` (the only guard against an SSE-parser perf regression)
- `test/fixtures/sse-splits.golden.json` — Frame-boundary pin for `createSseParser`; 66,039 splits asserted
- `e2e/capture/codex-recorder.ts` — Dev-only transparent forwarder. **Known defect**: cannot capture SSE from live backend (no `Content-Type` header — avoids PF-013)

## Related

- ADR-010 (Accepted): relay must be indistinguishable from the origin — drove removal of slot-based admission gate, removal (not deprecation) of Anthropic-leg stream timeout, and fail-open policy for ambiguous/unknown-provider routes
- ADR-006 (Accepted): Source the routable set from `MODEL_REGISTRY`, not a user-maintained `codex.models` list
- ADR-005 (Accepted): Route by exact model-name membership; resolution strictly before `decideRoute`; `decideRoute` now accepts `ModelResolution` (not raw string) enforcing this structurally
- ADR-008 (Accepted): Apply credential redaction once at the error render site (`toAnthropicErrorBody`); `redactCredentials` is called inside `toAnthropicErrorBody`, not at each relay call site
- ADR-002: Subscription OAuth passthrough — credentials from `~/.codex/auth.json`
- ADR-003: `store:false` encrypted reasoning round-trip; `sessionId` derived once outside retry loop
- ADR-004: `@types/node` pinned to Node-22 major
- PF-002: Drop `max_output_tokens` — backend rejects this field with 400
- PF-003: `system`-role → `developer`-role translation
- PF-004: `output_config.effort` → `reasoning.effort` propagation
- PF-005: The `e2e/README.md` parity table is the WRONG transport — do not use it to change header **names or values** in `buildHeaders`; it does **not** govern header **order**
- PF-006: Doctor's non-zero exit is load-bearing; never assert doctor exits 0
- PF-007: Alias targets validated, not just keys — a `claude-*` target becomes routable and misroutes main-thread traffic
- PF-008: An upstream without a per-item done event needs a synthesized close, or `aggregateFrames` returns a 200 with empty content; `flush()` now emits terminal frames when content is recoverable
- PF-011: A green suite proves nothing until each control has been proven RED against the mutation it claims to catch
- PF-012: The mutation-proof pass needs its own controls
- PF-013: The live Codex `/responses` stream sends no content-type header — the recorder cannot capture SSE without this
- `.devflow/features/cli-ux/KNOWLEDGE.md` — CLI UX layer; `subswitch models` command; doctor agent-scan; N-provider fan-out; `ProviderEvents<P>` compile-time log-injection control
