---
feature: codex-leg
name: Translated provider legs (Codex and Together) and the shared request runner
description: "Use when changing the Codex or Together leg, the shared runner, model resolution, conversation keys, provider log events or the Together key and child env. Keywords: codex, together, runTranslatedLeg, resolveModel."
category: domain-knowledge
directories: [src]
created: 2026-07-22
updated: 2026-11-19
---

# Codex Translation Leg (gpt-* → /responses)

## Rules
- **KB-AP-1** Do not log the message of a rejected credential load: the message can hold the key. Log only `errorCode` (the cause name, or `"unknown"`).
- **KB-INV-1** When `getCredentials` rejects and the signal is not aborted, `runTranslatedLeg` logs one `credentialLoadFailed` error line and replies 500 `"<name> credential load failed"`.
- **KB-INV-2** When `getCredentials` rejects after an abort, the runner logs nothing and sends the timeout reply.
- **KB-INV-3** A new runner event goes into both the `providerEvents` table and `TranslatedLegOptions.events`; the type `ProviderEvents<P>` pins the table.
- **KB-AP-2** Do not remove only the exact `TOGETHER_API_KEY` name from the native child env: Windows env names ignore letter case, so a different case form leaks the key.
- **KB-INV-4** `childEnvWithoutTogetherKey` drops every env name whose upper-case form equals `TOGETHER_API_KEY_ENV`; `KEY_NAME_CONSTANT_USES` in `test/unit/source-text-guards.test.ts` pins that line.
- **KB-AP-3** Do not run a "no Keychain read" check on linux: the reader returns before exec there, so a zero-exec check cannot fail. Use platform `"darwin"`, env `{}` and a positive control.
- **KB-INV-5** A workspace file can name a `together:` model and so spend the user's Together balance; `subswitch doctor` lists such a pin only when no usable key is found.
- The Rules list starts with this refresh. Older rules stay in `## Anti-Patterns` and `## Gotchas` below.

## Overview

subswitch translates Anthropic Messages API requests into OpenAI Responses API calls against `https://chatgpt.com/backend-api/codex/responses`. Routing is decided by `resolveModel` (in `src/models.ts`) and `decideRoute` (in `src/router.ts`), with `MODEL_REGISTRY` as the sole source of routable models (applies ADR-006). Everything else passes through to the Anthropic leg unchanged.

The pipeline has three stages: **resolve** in `server.ts`, **route** in `router.ts`, and **send**. `codex-handler.ts` translates the request. `translated-leg.ts` sends it and manages the response. The router accepts a typed `ModelResolution`, not a raw string.

**Together leg.** `together-handler.ts` uses the same runner to send Chat Completions requests to `<baseUrl>/chat/completions`. Each provider accessor carries a credential kind: `oauth-file` (Codex) or `api-key` (Together). A static key gets one attempt, no limit key and `redirect: "error"`. The request signal bounds the credential wait, so a client close ends a pending key read and no upstream request goes out. If the credential load rejects for a different cause, the runner logs the cause name only and replies 500 (see KB-INV-1).

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

`buildRoutingTable` is **total** — problems (rejected aliases, dangling targets, ambiguous families, reserved-name registry entries, unknown reasoning-effort declarations) are returned as diagnostic lists in `RoutingTableBuild`, not thrown. `buildDeps` logs each diagnostic and moves on.

### Five-Rule Resolution Contract (src/models.ts — resolveModel)

`resolveModel(table, name)` returns a `ModelResolution` discriminated union. Rules execute in order; the first match wins:

1. **Exact id** in `byId` → `{ kind: "resolved" }`. Canonical ids ALWAYS win — no alias can hijack a real model id. Retired and preview models are routable here.
2. **Alias** in `byAlias` → `{ kind: "resolved" }`. One hop only; Map built with `Object.hasOwn` at table-build time — prototype-pollution safe at request time.
3. **Qualified** `"provider:id"` or `"provider:family"` in `byQualified` → `{ kind: "resolved" }` when the prefix is in `PROVIDER_IDS`. An unknown prefix returns `{ kind: "unknown_qualifier" }` so callers can distinguish "bad provider" from "bad model". A known prefix with an unknown id/family returns `{ kind: "unresolved" }`. **Exception, the `together:` pass-through:** an unlisted id that passes the id grammar resolves to Together, and an id that fails it returns `{ kind: "invalid_qualified" }`. `server.ts` answers that with a marked local 400 (`x-subswitch-synthesized: 1`, "Invalid model id after the together: qualifier."), and no upstream gets the request. This is the only rule that accepts an arbitrary id. The id goes into the JSON body only, never into a URL or a header.
4. **Family** in `byFamily` → unique claimant: `{ kind: "resolved" }`; contested: `{ kind: "ambiguous", name, providers }`.
5. **Otherwise** → `{ kind: "unresolved" }`. Caller routes to Anthropic.

**`TOGETHER_MODELS` (`src/together-models.ts`) is empty** until the model-id data commit. `MODEL_REGISTRY` appends its entries as provider `together`. Until that commit, only the `together:` pass-through routes to Together.

**Retired models are in `byId` but not in `byFamily`.** An exact-id pin on a retired model keeps routing and receives a truthful upstream error; a bare family name never floats onto a retired model.

**Qualifying disambiguates contests.** A family claimed by two providers returns `ambiguous` from rule 4, but `codex:sol` still resolves via rule 3 — that is the entire point of qualified names. `byQualified` intentionally includes contested families; omitting them inverts the feature.

**Numeric gen tuple comparison.** `[5,10] > [5,6]` and `[6,0] > [5,99]` — comparison is numeric element-wise, NOT string comparison. Longer tuple wins on equal prefix (`[5,6,1] > [5,6]`). On exact tie, first-declared registry entry wins (update on `> 0` only, not `>= 0`).

**`selectFamilyWinners` is the ONLY implementation of the family selection rule.** It returns both views in one pass: `byProvider` (the per-provider partition, which `byQualified` needs so `codex:sol` resolves even when `sol` is contested) and `claims` (the collapsed per-family verdict — `unique` with the winning `ModelEntry`, or `contested` with the claimant list). `buildRoutingTable` maps `claims` to `byFamily`; `buildAliasRows`/`buildModelRows` read `flattenUniqueFamilies(claims)`. Neither side derives a winner for itself. A claim carries the winning `ModelEntry`, not its id — handing back an id forces every consumer to re-find the entry and invent a fallback for a miss that cannot happen.

**`collectAliasDeclarations` is the only reader of the per-provider alias record.** It applies the `Object.hasOwn` guard, the `PROVIDER_IDS`-order-then-key-order iteration, first-provider-wins deduplication, and the PF-007 `reserved` verdict. Deduplication applies only to non-reserved keys — a reserved declaration never binds the name, so a second provider's reserved declaration of the same name is still a distinct rejection. Both the router and the display classify from this one list.

**`preview: true`** entries are excluded from `byFamily` but resolvable by exact id. **`retired: true`** entries are excluded from `byFamily` and from qualified-family lookups, but resolvable by exact id and by `"provider:id"` qualified lookup.

**`isReservedAnthropicName` (renamed from `isAnthropicModelName`).** Two arms, case-insensitive: a prefix arm `inherit|sonnet|opus|haiku|claude-*` (so `sonnet[1m]`, `opusplan` are covered), and a word arm `fable|best` that matches the exact word or the word followed by a `[…]` variant suffix only (`fable[1m]` yes, `bestie`/`fabled` no). The list tracks Claude Code's documented subagent `model:` values and model-alias table (code.claude.com/docs/en/sub-agents, /docs/en/model-config, checked 2026-09-26); `default` is deliberately not reserved — the docs call it a reset value, "not itself a model alias". Used in three places that must never disagree:
- `config.ts` AliasesSchema refines — reject alias keys or values at config-parse time.
- `buildRoutingTable` `byAlias` construction — entries matching the predicate are added to `rejectedAliases` and skipped.
- `agent-scan.ts` `checkAgentModels` — a reserved name is skipped, so doctor never flags a Claude subagent (e.g. `model: fable`) as unresolvable.

### Reasoning Effort Vocabulary (src/models.ts)

`DEFAULT_REASONING_EFFORTS` (`as const`) is now the single effort vocabulary for the whole Codex leg — `["none", "minimal", "low", "medium", "high", "xhigh", "max"]`. The former `CODEX_EFFORT_VALUES` constant that used to live in `codex-request.ts` is **gone**; `codex-request.ts` imports `reasoningEffortsForModel` from `models.ts` instead of holding a second copy — a duplicated vocabulary drifts the moment one copy is updated.

`reasoningEffortsForModel(registry, model)` is TOTAL: it returns the matching entry's own `reasoningEfforts` when the registry declares one, otherwise `DEFAULT_REASONING_EFFORTS`. Every consumer does one positive membership test against one authority rather than branching between two. **The `model` argument MUST be the canonical registry id** — an alias misses the internal `find` and silently falls back to the wider default set, which would let a model that declares a narrower vocabulary accept an effort it should reject. This precondition is the same one ADR-007 documents for conversation-key derivation; `handleMessages` substitutes the canonical id before `translateRequest` runs, and `translateEffort` (the only call site, in `codex-request.ts`) inherits that guarantee.

`gpt-6-astra` (family `astra`, `gen: [6]`) is the first registry entry to declare a narrower `reasoningEfforts` set: `["low", "medium", "high", "xhigh", "max"]` — five values, deliberately excluding `ultra`. `test/fixtures/native/codex-0.153.3-model.json` (the native Codex CLI's own model catalog, captured on the reverse-ingress leg) advertises a sixth value (`ultra`), but that is **not** evidence for adding it here: the reverse adapter rejects `ultra` with `unsupported_reasoning_effort`, and the two legs describe different backends and are allowed to disagree. Do not add a registry-vs-fixture equality test (avoids PF-004, PF-023).

`buildRoutingTable`'s self-check pass also flags any registry entry whose `reasoningEfforts` contains a value outside `DEFAULT_REASONING_EFFORTS` — reported as `unknownReasoningEfforts: { id, efforts }[]` on `RoutingTableBuild` (a narrowing set can only shrink the backend vocabulary, so a value outside it is unreachable and almost certainly a typo). `buildDeps` logs each as `warn registry_entry_unknown_effort`, alongside the other `buildRoutingTable` diagnostics (`alias_rejected`, `alias_dangling_target`, `ambiguous_family`, `registry_entry_uses_reserved_name`).

`buildModelRows` emits the per-model `reasoningEfforts` field on `ModelRow` **only** when the registry entry declares one — absence means the default set applies; emitting the default unconditionally would make every row claim a narrowing it does not have. This is what `subswitch models --json` surfaces per model.

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

`handleMessages` signature: `(req, res, rawBody, parsed, canonicalModel)`. The canonical model is threaded because `deriveConversationKey` hashes the model string — an alias and its canonical produce DIFFERENT `session_id` and `prompt_cache_key` without substitution. The same threaded canonical is what `translateEffort` (via `reasoningEffortsForModel`) depends on — see Reasoning Effort Vocabulary above.

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
- `output_config.effort` → `reasoning: { effort }` (applies PF-004). `translateEffort` validates the value against `reasoningEffortsForModel(MODEL_REGISTRY, model)` — a per-model vocabulary, not one fixed set (see Reasoning Effort Vocabulary above). Unknown values emit `unsupported_effort_dropped` and degrade to the backend default, never 400.

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

The handler computes `sessionId` once before it calls the runner. Both the initial attempt and the 401-refresh retry use that value.

The runner in `src/translated-leg.ts` permits two attempts for a renewable credential and one for a static credential. It starts the total timer and attaches the close listener before it calls `auth.getCredentials(signal)`. The runner clears the timers and removes the listener on exit.

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
  → readBodyForRouting (raw bytes preserved; over_window → prefix+pipe or 413; client_disconnected → drop)
      ├── complete (body ≤ window) → JSON.parse → peekModel → decideRoute
      └── over_window (body > window)
          ├── Anthropic-bound → sniffLeadingModel(prefix) → stream to upstream (no 413; ADR-010)
          └── provider-bound → 413 request_too_large + drainRejectedUpload
  → deps.resolve(model) → ModelResolution (table built once at startup in buildDeps)
  → decideRoute(method, path, resolution) → Route
      ├── "ambiguous" → warn ambiguous_model_name; forward to Anthropic (fail open, ADR-010)
      ├── "unknown_provider" → warn unknown_provider_qualifier; forward to Anthropic
      └── "provider" → dispatch to handleMessages or handleCountTokens
  → deps.providers["codex"].handleMessages(req, res, rawBody, parsedBody, canonical)
      → AnthropicRequestSchema.safeParse(parsedBody)
      → canonical substitution (model field → canonical in `request`)
      → deriveConversationKey (hashes canonical model + system + first user msg)
      → translateRequest (codex-request.ts; ReasoningCache for reasoning re-injection;
        translateEffort validates against reasoningEffortsForModel(MODEL_REGISTRY, canonical))
      → runTranslatedLeg (translated-leg.ts)
      → AbortController, total timer, and close listener
      → auth.getCredentials(signal) → ProviderCredential<"codex">
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
| Credential load rejects (`auth.getCredentials` throws) | Signal not aborted: one `error` line with the event `credentialLoadFailed` (`<provider>_credential_load_failed`) and the fields `model` and `errorCode` only. `errorCode` is the cause's `name`, or `"unknown"` for a non-`Error` value. The client gets 500 `"<name> credential load failed"`. Signal aborted: no log line, and the client gets the timeout reply. |
| Abort (client close or timeout) | `AbortController` shared between `res.on("close")` and total/idle timers. Idle timer resets on each data chunk. |
| `reasoning_cache_miss` | Degraded, not broken. Warning logged as `errorCode`. |
| Over-window body (Codex-bound) | 413 with `request_too_large`. `drainRejectedUpload()` lets remaining upload drain via FIN rather than RST. The relay is the origin on the Codex leg and cannot translate a body it cannot hold — 413 is authoritative here (ADR-010). `IngestError` has no `body_too_large` variant; the 413 is emitted in the dispatch switch. |
| `client_disconnected` | Client is gone — no HTTP response sent. Single variant of `IngestError` (module-local, `server.ts`). Excluded from `ProxyError` so `proxyErrorToAnthropic` can never be called with it. |

## Anti-Patterns

**Aligning `/responses` headers to `codex exec` wire captures.** The parity gaps table in `e2e/README.md` documents analytics-endpoint headers from the wrong transport (avoids PF-005). Changing `buildHeaders` to match that table will break the working `/responses` HTTP leg. PF-005 forbids using the wrong-transport capture table to change header **names or values**; it does **not** govern header **order**.

**Naming `authorization` / `chatgpt-account-id` explicitly in `buildHeaders`.** Building the header object by spelling out `authorization` and `chatgpt-account-id` by name re-hardcodes one provider's header names into a provider-neutral handler. Credentials supply their own names via `authHeaders`; `buildHeaders` must not know what those names are — the `put()` guard writes transport constants and the credential's own entries land first.

**Writing a provider translator with no terminal reconciliation.** Any upstream lacking a per-item done event needs its content-block closes synthesized at the terminal event — a Chat Completions–style upstream must synthesize them from `finish_reason` (avoids PF-008). Omitting this is silently lossy on every non-streaming request while the whole streaming test suite stays green.

**Moving `reconcileOpenBlocks` out of the terminal handler and into `flush()`.** The synthesised closes must be emitted in band, before `message_delta` and `message_stop`. `flush()` is the truncation path only, guarded on `finished`.

**Synthesising a close for every open block.** Only blocks in `blocksWithContent` get a stop; a block that received zero deltas is discarded. Closing it appends a spurious empty text block to the assembled response.

**Pruning `blockIndexByKey` on `content_block_stop`.** A late delta for a closed block would then become `sawUnmatchedDelta`. If no other block received content, this triggers a spurious 502 from `reconcileOpenBlocks`. The map is bounded by `MAX_CONTENT_BLOCKS` instead.

**Deriving the conversation key from builder output.** `deriveConversationKey` must receive `request` (with canonical model substitution), not the result of `translateRequest`. Builder output may have system-role messages translated to developer-role (PF-003).

**Passing an alias instead of a canonical to handleMessages.** The fifth parameter `canonicalModel` must be a resolved canonical id. Passing an alias means `deriveConversationKey` hashes the alias — breaking cache coherence and session correlation. The same holds for `translateEffort`'s call into `reasoningEffortsForModel` (applies ADR-007).

**Moving sessionId derivation inside the retry loop.** The 401-refresh retry reuses the same `sessionId` computed before the loop. A new id per attempt breaks session correlation on the backend.

**Passing `max_tokens`/`max_output_tokens` to the Responses API.** The Codex backend returns 400 for this field. Drop it unconditionally (avoids PF-002).

**Routing before resolving.** `decideRoute` must receive a typed `ModelResolution`, never a raw string (applies ADR-005).

**Omitting contested families from `byQualified`.** A family claimed by two providers must still resolve via `codex:sol`.

**Re-deriving a family winner anywhere outside `selectFamilyWinners`.** Consume `claims` or `flattenUniqueFamilies(claims)`.

**Re-deriving the reasoning-effort vocabulary instead of calling `reasoningEffortsForModel`.** `DEFAULT_REASONING_EFFORTS` has exactly one home in `models.ts`. A second hardcoded list — the deleted `CODEX_EFFORT_VALUES` was exactly this — drifts the moment one copy is updated.

**Hand-listing reserved OpenAI names on the Claude ingress leg instead of deriving them from `MODEL_REGISTRY`.** `isOpenaiModelName` is built by `buildOpenaiModelNamePredicate(MODEL_REGISTRY)` precisely so a family added to the registry (e.g. `astra`) is automatically reserved against `codexIngress.claude.aliases` — the mirror image of PF-007 on the reverse leg. A hand-written alternation silently misses new registry entries.

**Falling back to `PROVIDER_IDS[0]` for an unknown provider.** The declaring provider is always in hand — `collectAliasDeclarations` carries it. A first-provider assumption is correct only by coincidence while `PROVIDER_IDS.length === 1`.

**Regenerating `test/fixtures/sse-splits.golden.json` to make a parser change pass.** The golden was captured from the parser before the deferred-join rewrite and is the definition of "frame boundaries unchanged". Regenerate it only when the corpus itself grows.

**Joining the SSE accumulator outside the boundary branch.** `createSseParser` holds undelivered text as an array of segments and joins only on the chunk that completes an event. Adding a `pending.join("")` on the no-boundary path restores the quadratic behaviour — 38x slower at 8 MiB. `codex-recorder.ts`'s capture accumulator mirrors this pattern for the same reason.

**"Fixing" count_tokens by forwarding to Anthropic.** The estimate is deliberate: Anthropic returns counts for Claude's tokenizer, not for the Codex model. The chars/4 heuristic is correct; forwarding is wrong.

**Synthesizing a 400/429/503 for an ambiguous model name.** The policy is fail open (ADR-010). A relay-invented 400 naming our registry is a status the origin never emits. `Route.ambiguous` stays in the router for classification; the server decides the policy.

**KB-AP-1 — Logging the message of a rejected credential load.** A key loader error can carry the key or a part of it in its message text. The runner in `src/translated-leg.ts` logs only the cause name as `errorCode`. The closed `LogFields` set in `src/logger.ts` is the log redaction control, but `errorCode` is a free string. The error render site redacts credentials only in error bodies, not in log fields. Thus a log call that puts `cause.message` in `errorCode` writes the credential to the log.

**KB-AP-2 — Removing only the exact key name from the child env.** On Windows, env names ignore letter case, so `together_api_key` and `TOGETHER_API_KEY` are the same variable for the child. A `delete env.TOGETHER_API_KEY` keeps the other case forms, and the native client gets the metered key. Use `childEnvWithoutTogetherKey` in `src/run-action.ts`, and test it in `test/unit/run-action-env.test.ts`.

**KB-AP-3 — A Keychain check that cannot fail.** On linux the Together key reader returns before it calls exec. Thus an "exec count is zero" check passes on linux for every code path. Run the check with platform `"darwin"` and env `{}`, so that each key read must go through the Keychain seam. Keep a positive control that proves the seam counts a read (see the `keychainOnly` fixture in `test/integration/together-leg.test.ts`).

## Gotchas

**KB-INV-1 / KB-INV-2 — Two replies for a rejected credential wait.** The runner wraps `auth.getCredentials(signal)` in `abortable`, so a credential source that ignores the signal cannot hold the request open. The `.catch` checks `signal.aborted` first. An aborted wait does not log, and the later abort check sends `"<name> request timed out"`. Any other rejection logs once and sends 500 `"<name> credential load failed"`. Thus a client close or a timeout does not make a false fault line in the log.

**KB-INV-3 — Runner events have two declarations.** `TranslatedLegOptions.events` in `src/translated-leg.ts` lists the event names that the runner uses. `providerEvents` in `src/provider-events.ts` makes them from the provider id. When you add a runner event, add the field to `ProviderEvents<P>`, to the table in `scopedEvents`, and to `TranslatedLegOptions.events`. The handler passes its provider table to the runner, so the type check finds a missing field.

**KB-INV-4 — The key-name guard pins exact source lines.** `test/unit/source-text-guards.test.ts` lets the Together key-name constant appear outside `src/together-auth.ts` only on the exact trimmed lines in `KEY_NAME_CONSTANT_USES` (an import from the key reader is also permitted). The guard also rejects the literal key name and computed env reads outside the key reader, so the env filter must use the constant. The `src/run-action.ts` entry is the line `if (name.toUpperCase() === TOGETHER_API_KEY_ENV)`. If you change that line, change the guard entry in the same commit.

**KB-INV-5 — A workspace file can select the Together route.** Only the user config or an explicit `SUBSWITCH_CONFIG` can set the `providers.together` block, the routes and the profiles. But a project `.claude/agents/*.md` file or a project Claude Code setting can name a `together:` model. When a key is available, those requests go to Together and spend the user's balance. `subswitch doctor` lists a Together agent pin only when no usable key is found (`keyRequiredProviders` in `src/doctor.ts`). README and SECURITY.md tell users to check a cloned repository for such names.

**`stream: true` is always sent, even when the client sets `stream: false`.** subswitch always requests an SSE stream from the backend, then `aggregateFrames` assembles a non-streaming response.

**`session_id` appears in two different places with different semantics.** In `buildHeaders`, it is a request header. In live `codex exec` analytics captures, `session_id` appears as a body field in analytics POSTs — different transport.

**`blockIndexByKey` is NOT pruned on `content_block_stop` — this is intentional.** A late delta for a closed block (which can arrive if the upstream reorders events) would be classified as `sawUnmatchedDelta` if the key were pruned. With no other block receiving content, that triggers a spurious 502. The map is bounded by `MAX_CONTENT_BLOCKS = 1024` instead.

**`subswitch.config.example.json` must stay in sync with the strict schema.** After `CodexProviderSchema`, `AnthropicSchema`, `LimitsSchema`, and `FileConfigSchema` became `z.strictObject`, an unknown key in the example file is a hard load error, not a cosmetic drift. Anyone updating the schema must update the example file.

**`addEventListener("abort", …)` never fires on an already-aborted signal.** In `createFrameWriter`, the drain-wait loop registers an abort listener. If the signal is already aborted when a frame needs a drain wait, the listener never fires — the request hangs forever. The fix is the explicit `signal.aborted` check placed after `res.write` so an in-flight frame still goes out. Any future backpressure wait must replicate this pattern.

**`Object.hasOwn` is required for alias lookup.** `buildRoutingTable` builds `byAlias` using `Object.hasOwn` during table construction; all request-time lookups are then `Map.get()` which is prototype-pollution safe.

**`prompt_cache_key` is absent from `codex exec` HTTP captures.** This is correct — inference goes via WebSocket, not HTTP. The field IS valid on the `/responses` HTTP API (proved by 76% cache hit observed live 2026-07-21).

**`maxSseEventBytes` counts UTF-16 code units, not bytes, despite the name.** The check runs per chunk against the undelivered residual, bounding accumulated text length; segment-array object and header overhead is uncounted, so actual heap can exceed the limit significantly at per-byte-chunk scale (roughly 96 MiB uncounted at the 4 MiB default with 1-byte chunks). `codex-recorder.ts`'s `MAX_SSE_BUFFER_CHARS` uses the same unit for the same reason.

**`MIN_COMPACT_CHARS` compaction ADDS copying — that is the accepted cost.** Compaction's actual payoff is bounding segment-array overhead in the small-chunk case: a 1 MiB event arriving in 1-byte chunks would build ~1M segments without it; with it the peak is halved. The copy overhead is linear (+50%/+20%/+23% at 2/4/8 MiB). A fixed-count trigger would reintroduce O(n²/N) and must be rejected.

**Parallel tool calls share reasoning items.** When the backend returns multiple function calls in one response, all share the same `reasoningItems` buffer. `injectReasoningItems` deduplicates by `item.id` using `injectedReasoningIds`, but reasoning items are re-injected for each call. This is by design.

**No test in the suite can catch an SSE-parser performance regression.** The slow path is byte-for-byte correct, so it passes all golden split assertions. `node --import tsx test/tools/sse-parser.bench.ts` is the only artifact that distinguishes them — run it after any `createSseParser` edit.

**`codex-recorder.ts`'s headerless-SSE capture defect is FIXED — PF-013 is resolved.** Eligibility for the capture arm is now `POST` method **+** path ends `/responses` **+** a 2xx upstream status **+** a request body that declared `"stream": true` (`isExpectedMissingHeaderStream`), evaluated alongside the original explicit `Content-Type: text/event-stream` check (`isSseResponse`). The request body is decoded and JSON-parsed exactly once (`parseJsonBody`); that single result feeds both the printed body-shape skeleton and the stream-eligibility check. `forward()` runs before `capture()` per chunk (ADR-010 — transparency does not wait on successful parsing) and honours `res.write`'s backpressure signal by pausing/resuming the upstream response; one `StringDecoder` per response prevents a multi-byte sequence split across writes from decoding as replacement characters.

**The recorder's capture buffer is bounded independently of the forward path.** `MAX_SSE_BUFFER_CHARS` (4 MiB, UTF-16 code units) bounds the undelivered-segment accumulator; on overflow, capture prints a `<cap:sse-residual>` notice and stops for that response, while every byte keeps flowing to the client untouched (ADR-010, ADR-012). `MAX_SSE_EVENTS = 200` separately caps how many event-type lines are *printed* (a counter keeps running past it); the `TERMINAL USAGE:` line for `response.completed` prints once regardless of the event-print cap — decoupled from `MAX_SSE_EVENTS`.

**`createCodexRecorderServer(upstream, output?, { allowInsecureUpstream }?)` is import-safe and vets its upstream at construction, not at listen time.** It returns an `http.Server` that does not call `.listen()` — tests and local probes bind an ephemeral loopback port themselves. `upstreamRefusal` applies ADR-009: any scheme to a loopback host is exempt (via `isLoopbackHost` imported from `src/config.ts`, never a hand-rolled prefix test — PF-026); `https://chatgpt.com` is the trusted default; any other https host needs `CODEX_RECORDER_ALLOW_INSECURE_UPSTREAM=1` or `{ allowInsecureUpstream: true }`; cleartext `http:` to a non-loopback host is refused outright regardless of the opt-in.

**`failExchange`'s teardown predicate is independent of `res.headersSent` (PF-022).** `headersSent` is the "have we replied" latch, claimed the moment a status is relayed — it cannot double as the teardown guard, because that would skip cleanup for exactly the mid-stream failure teardown exists to handle. Before a reply, `failExchange` synthesizes a status; after one, it destroys the socket. Separately, `res.once("close", …)` destroys the in-flight upstream request when the *client* disconnects mid-exchange.

**Captured text is sanitized before it reaches the transcript.** `renderCaptureToken` strips C0/C1 control characters and DEL, then caps length at 128 chars, applied to every upstream-controlled string (event `type`, usage keys) — the header's promise that the transcript never forges a line is enforced here, not assumed. `numericUsage` separately projects a `usage` object down to finite numbers only, bounded in depth (3) and field count (32); non-numeric leaves are dropped.

**The recorder's request counter, uncaught-exception guard, and build inclusion are all scoped narrowly.** `requestSeq` is a closure variable inside `createCodexRecorderServer`, so several recorders constructed in one process (as the integration suite does) each number their own requests starting from `#1`. The `uncaughtException` handler is registered only inside the `isDirectExecution` (CLI) block, not the factory — the factory stays import-safe for library/test consumers. The file is in `tsconfig.json`'s `include` (type-checked) but absent from `tsconfig.build.json` (`src/**/*.ts` only) — it never reaches `dist`.

**The Codex leg has a stream idle timeout; the Anthropic leg does not — this is a genuine asymmetry.** `providers.codex.streamIdleTimeoutMs` is live and intentional (default 300 s). The Anthropic leg has no post-connect timer at all by design (ADR-010): `connectTimeoutMs` bounds DNS+TCP establishment only. `anthropic.streamIdleTimeoutMs` was **removed** in 0.3.0 — it is a `removed`-kind row in `LEGACY_KEY_ENTRIES` and `loadConfig` returns `err` (the relay refuses to start) if it appears in config. `anthropic.headerTimeoutMs` was never shipped and is not in `LEGACY_KEY_ENTRIES`; it is rejected by `z.strictObject` as an unrecognised field. `LEGACY_KEY_ENTRIES` has a `moved` row migrating `limits.streamIdleTimeoutMs` → `providers.codex.streamIdleTimeoutMs`; there is no Anthropic equivalent. Any code that assumes both legs have matching timeout behavior is wrong.

**Pooled outbound sockets already carry OS-level TCP keepalive.** The outbound `http.Agent` is constructed with `{ keepAlive: true, … }`, which causes Node to enable TCP keepalive (1 s initial delay) on every socket it pools. No explicit `setKeepAlive()` call is needed or present.

**Test suite must run alone; globs are flat and non-recursive.** Test globs are `test/unit/*.test.ts` and `test/integration/*.test.ts` — they do NOT descend into subdirectories. The suite has a hard 30 s per-test timeout and no fake timers. Wall-clock assertions flake when run alongside parallel processes (e.g. `tsc`). Always run the suite alone when validating timing-sensitive behavior.

## Key Files

- `src/server.ts` — Wiring site for resolve→route→send; `buildDeps` calls `buildRoutingTable` once and logs its diagnostics (`alias_rejected`, `alias_dangling_target`, `ambiguous_family`, `registry_entry_uses_reserved_name`, `registry_entry_unknown_effort`); `deps.resolve` closure; `deps.providers[decision.provider].handleMessages` dispatch; ambiguous fail-open policy; `IngestError` (server-local, single variant `client_disconnected`, not `ProxyError`); `readBodyForRouting` + over-window routing (Anthropic→stream, Codex→413); `drainRejectedUpload` in `dispatch().catch` for paused-req safety; `applyInboundPolicy` (from `src/inbound-policy.ts`) owns `SERVER_TUNING` + `clientError` handler
- `src/models.ts` — Pure registry module (no repo imports); `MODEL_REGISTRY` (`gpt-6-astra` is the first entry with per-model `reasoningEfforts`), `PROVIDER_IDS`, `AliasesByProvider`, `DEFAULT_REASONING_EFFORTS`, `reasoningEffortsForModel`, `buildRoutingTable` (`unknownReasoningEfforts` diagnostic), `resolveModel`, `isReservedAnthropicName`, `routableModelCount`, `formatModelsReport`, `buildModelRows` (`ModelRow.reasoningEfforts`), `buildAliasRows`
- `src/claude-models.ts` — Reverse-leg (Claude ingress) model registry; `buildOpenaiModelNamePredicate(registry)` derives `isOpenaiModelName` from `MODEL_REGISTRY` (mirror of PF-007 on the reverse leg — `astra` is now automatically reserved); `validClaudeAlias` (the only gate on `codexIngress.claude.aliases`); `claudeResolver`, `claudeModelRows`, `augmentCodexModels` (advertises each model's own `defaultEffort` as `default_reasoning_level`, levels low..max); `CLAUDE_MODELS` entries carry REQUIRED capability fields (`maxOutputTokens`, `thinkingAlwaysOn`, `forcedToolChoice`, `defaultEffort`); `claudeModel(id)` lookup; `isClaudeModelName` (the `claude-`/`claude:` namespace, case-insensitive) and `displayModelName` (bounded, charset-neutralized echo of a client-supplied name)
- `src/router.ts` — Pure routing decision; accepts `ModelResolution` (not raw string); zero name matching; exhaustive switch; classification only — policy lives in server.ts
- `src/codex-handler.ts` — `createCodexHandler`, `buildHeaders`, canonical model substitution, stable session ID, and `handleCountTokens`.
- `src/translated-leg.ts` — `runTranslatedLeg` manages aborts, timers, the retry limit, both limit observers, and response delivery. A rejected credential load logs `credentialLoadFailed` with the cause name only and replies 500; an aborted wait gets the timeout reply.
- `src/provider-transport.ts` — `createFrameWriter`, `readBoundedText`, `respondJson`, and `respondProxyError` with optional extra headers.
- `src/provider-handler.ts` — `ProviderHandler` interface; P4 contract documented
- `src/codex-request.ts` — All request translation logic; `translateRequest`, `translateEffort` (validates via `reasoningEffortsForModel(MODEL_REGISTRY, model)`), `estimateTokens` (chars/4 heuristic)
- `src/anthropic-parse.ts` — `buildInstructions` (moved from `codex-request.ts`); `textOfBlocks`
- `src/conversation-key.ts` — Deterministic v7-shaped UUID from sha256 of canonical request
- `src/codex-response.ts` — `MAX_CONTENT_BLOCKS`; SSE parser (segment array; linear); Anthropic SSE translator state machine; `aggregateFrames`; `blockIndexByKey` NOT pruned on stop
- `src/codex-auth.ts` — `CodexAuthManager`; all 7 auth events now table-derived via `events: ProviderEvents<"codex">`; `callTokenEndpoint` uses `AbortSignal.timeout(15_000)`; `forceRefresh()` 30s cooldown; `writeAtomic` self-heals EEXIST
- `src/provider-events.ts` — `providerEvents<P>(id): ProviderEvents<P>`; one table of handler, runner and translator events (`credentialLoadFailed` included), `insecureBaseUrlScheme` and the auth events, pinned by the `ProviderEvents<P>` type; compile-time log-injection control
- `src/config.ts` — `providers.codex.streamIdleTimeoutMs` (default 300 s, live); `anthropic.streamIdleTimeoutMs` removed in 0.3.0 (ADR-010) — `removed`-kind row in `LEGACY_KEY_ENTRIES`, hard-errors on load; `anthropic.headerTimeoutMs` never shipped — rejected by `z.strictObject`, not in table; `LEGACY_KEY_ENTRIES` has a `moved` row for `limits.streamIdleTimeoutMs` → `providers.codex.streamIdleTimeoutMs`; `providers.codex.maxAggregateBytes` (64 MiB default); strict schemas via `z.strictObject`; `isLoopbackHost` (exact-form predicate, reused by `codex-recorder.ts`)
- `src/errors.ts` — `ProxyError` union (auth/upstream/translate/timeout); `IngestError` is server-local (single variant `client_disconnected`, excluded from `ProxyError`); `AnthropicErrorType` includes `not_found_error`; `upstreamStatusToAnthropicError`; 504→timeout and 502→upstream are both intentional (ADR-010); `registerExactCredential` receives the loaded Together key, and `toAnthropicErrorBody` replaces that exact value in every error body it renders
- `src/agent-scan.ts` — `unknown_provider` severity is `"info"`; `ambiguous` severity is `"fail"`; `provider_unconfigured` is `"fail"` only for a provider in `keyRequiredProviders` (Together)
- `src/together-auth.ts` — Key loader: `TOGETHER_API_KEY` first, then on macOS only the Keychain item "Subswitch Together API key" (account `subswitch`) through `/usr/bin/security` with execFile, a 10 s timeout, an 8 KiB buffer and a HOME-only env. One shared read; a failed read is not kept. A missing or malformed key gives a marked local 401 that names the env var and the Keychain item, with no upstream request and no Anthropic fallback. The value is never echoed.
- `src/together-handler.ts` — Together leg on the runner: outbound headers from an allow-list (Bearer key, content-type, accept, fixed user-agent); fixed error text with a strict code; 402 balance text; `x-should-retry: false` on 504, 524 and the runner timeout; local count_tokens estimate
- `src/together-request.ts`, `src/together-response.ts` — Body allow-list with `max_tokens` clamped to the output cap (default 16384, user config only); stream translator with per-response tool ids
- `src/run-action.ts` — `childEnvWithoutTogetherKey(parent)` makes the native child env: it drops every name whose upper-case form equals `TOGETHER_API_KEY_ENV`, because Windows env names ignore letter case
- `test/unit/source-text-guards.test.ts` — `KEY_NAME_CONSTANT_USES` lists each permitted source line that uses the Together key-name constant outside `src/together-auth.ts`
- `test/tools/` — `sse-parser.bench.ts` (the only guard against an SSE-parser perf regression)
- `test/fixtures/sse-splits.golden.json` — Frame-boundary pin for `createSseParser`; 66,039 splits asserted
- `e2e/capture/codex-recorder.ts` — Dev-only transparent wire-capture forwarder; `createCodexRecorderServer` factory (import-safe; upstream vetted at construction per ADR-009); the PF-013 headerless-SSE capture defect is **fixed**; capture bounded by `MAX_SSE_BUFFER_CHARS` (4 MiB) while forwarding never is (ADR-010/ADR-012)
- `test/integration/codex-recorder.test.ts` — 25 tests; the only executable proof of the recorder's eligibility rule, backpressure, teardown, and upstream-vetting behavior

## Related

- ADR-010 (Accepted): relay must be indistinguishable from the origin — drove removal of slot-based admission gate, removal (not deprecation) of Anthropic-leg stream timeout, and fail-open policy for ambiguous/unknown-provider routes; also governs `codex-recorder.ts`'s forward-before-capture ordering
- ADR-006 (Accepted): Source the routable set from `MODEL_REGISTRY`, not a user-maintained `codex.models` list
- ADR-005 (Accepted): Route by exact model-name membership; resolution strictly before `decideRoute`; `decideRoute` now accepts `ModelResolution` (not raw string) enforcing this structurally
- ADR-007 (Accepted): Canonical id routes and is hashed into the conversation key, while the as-requested name stays in a separate local for logs — the same precondition `reasoningEffortsForModel` depends on
- ADR-008 (Accepted): Apply credential redaction once at the error render site (`toAnthropicErrorBody`); `redactCredentials` is called inside `toAnthropicErrorBody`, not at each relay call site
- ADR-009 (Accepted): Vet every credential-bearing URL against its expected default host at startup, opt-in for a mismatch — governs `codex-recorder.ts`'s `upstreamRefusal`
- ADR-012 (Accepted): An ingestion cap must be a memory bound, not an admission gate — the same principle `MAX_SSE_BUFFER_CHARS` follows in `codex-recorder.ts` (capture degrades on overflow; forwarding never does)
- ADR-002: Subscription OAuth passthrough — credentials from `~/.codex/auth.json`
- ADR-003: `store:false` encrypted reasoning round-trip; `sessionId` derived once outside retry loop
- ADR-004: `@types/node` pinned to Node-22 major
- PF-002: Drop `max_output_tokens` — backend rejects this field with 400
- PF-003: `system`-role → `developer`-role translation
- PF-004: `output_config.effort` → `reasoning.effort` propagation; also why `gpt-6-astra` deliberately excludes `ultra` from its `reasoningEfforts`
- PF-005: The `e2e/README.md` parity table is the WRONG transport — do not use it to change header **names or values** in `buildHeaders`; it does **not** govern header **order**
- PF-006: Doctor's non-zero exit is load-bearing; never assert doctor exits 0
- PF-007: Alias targets validated, not just keys — a `claude-*` target becomes routable and misroutes main-thread traffic; `buildOpenaiModelNamePredicate` is the mirror image on the reverse leg
- PF-008: An upstream without a per-item done event needs a synthesized close, or `aggregateFrames` returns a 200 with empty content; `flush()` now emits terminal frames when content is recoverable
- PF-011: A green suite proves nothing until each control has been proven RED against the mutation it claims to catch
- PF-012: The mutation-proof pass needs its own controls
- PF-013: The live Codex `/responses` stream sends no content-type header — **fixed** in `codex-recorder.ts`: capture eligibility now also accepts a request that declared `stream:true` on a 2xx `/responses` POST, in addition to an explicit SSE content type
- PF-022: A one-way "we have replied" latch cannot guard teardown — `codex-recorder.ts`'s `failExchange` predicate is independent of `res.headersSent`
- PF-023: Prose drifts — cited by the `gpt-6-astra` registry comment for why no registry-vs-native-fixture equality test exists
- PF-026: A loopback predicate must not be a prefix test — `codex-recorder.ts` reuses `isLoopbackHost` from `src/config.ts` rather than a hand-rolled check
- `.devflow/features/cli-ux/KNOWLEDGE.md` — CLI UX layer; `subswitch models` command; doctor agent-scan; N-provider fan-out; `ProviderEvents<P>` compile-time log-injection control

## Native Codex → Claude ingress (2026-09-08)

The forward leg described above remains the default. `Config.codexIngress` adds an
opt-in reverse leg, enabled by `init --client codex|all`. Claude models and aliases
resolve by exact membership; `decideCodexRoute` consumes a typed resolution for both
HTTP and WebSockets. `CodexGateway` wires `CodexUpstream`, `CodexWebSockets`, native auth,
and `ClaudeHandler`. Both HTTP directions use `createRawHttpForwarder`; only complete
native requests with substituted credentials may refresh and retry once after 401.

`src/claude-models.ts`'s `isOpenaiModelName` is derived from `MODEL_REGISTRY` via
`buildOpenaiModelNamePredicate` rather than a hand-written alternation, so a family added
to the registry (`astra`, and any future one) is automatically reserved against
`codexIngress.claude.aliases` with no corresponding code change required.

`CLAUDE_MODELS` (2026-11-18): claude-sonnet-5, claude-sonnet-5-5, claude-haiku-5-5,
claude-opus-5, claude-opus-5-5, claude-fable-5, claude-fable-5-1, claude-fable-5-2.
Family defaults by `gen`: `opus` -> claude-opus-5-5, `fable` -> claude-fable-5-2,
`sonnet` -> claude-sonnet-5-5, `haiku` -> claude-haiku-5-5. Older exact IDs remain routable.
Each entry declares its capabilities. `claude-adapter.ts` enforces them on the resolved ID.
Effort `none` on a `thinkingAlwaysOn` model returns a 400 `reasoning_effort_unsupported_by_model`.
These models are fable-5, fable-5-1, fable-5-2, opus-5-5, and sonnet-5-5.
Forced tool choice (`required` or a named tool) returns a 400 `tool_choice_unsupported_by_model` when tools are present.
This applies to fable-5-1, fable-5-2, opus-5-5, and sonnet-5-5 (`forcedToolChoice: false`).
The adapter refuses the request; it does not rewrite it.
The adapter caps `max_tokens` at the entry's `maxOutputTokens`.
A target with no catalog entry has no capability data, so these limits do not apply.
`ReverseContractError` accepts an optional `detail` that `claudeFailure` uses instead of the generic message.

A `claude-*`/`claude:*` name (case-insensitive) that is neither a catalog id nor a configured
alias or target resolves to `{ kind: "unregistered" }`, which `decideCodexRoute` turns into a
400 `unregistered_claude_model` on HTTP, WebSocket and the over-window path - it is never
forwarded to OpenAI (applies ADR-011: OpenAI could not act on it). The echoed name passes
through `displayModelName`. This is refusal, not wildcard routing (ADR-005 holds). `codex
doctor` uses the same `isClaudeModelName` predicate to flag agent models the gateway refuses.

Claude credential infrastructure is created in `buildDeps`. Native token substitution
is restricted to exact native endpoints and matching account IDs. `errors.ts` owns both
wire protocols' redaction. `claude-errors.ts` maps each failure code to an explicit status.
`ClaudeCache` shares the configured `codexIngress.claude.reasoningCache` budget across
continuation snapshots, thinking replay, and adaptation markers. Missing state returns
409. `content-encoding.ts` owns async codecs and the native zstd capability check.

`claude-adapter.ts` translates complete histories; `claude-stream.ts` tracks explicit
stream phases and per-block state, then commits executable tools only at a valid terminal.
Collaboration namespace adaptation applies to OpenAI turns too when Claude routing is
enabled. All `/codex` paths are reserved even when disabled. Raw TCP connect budgets do
not impose TLS, HTTP-header, WebSocket-handshake, or established-stream deadlines.

CLI `--client` defaults and merged configuration provenance are documented in the CLI UX
KB. Both directions use `allowInsecureBaseUrl` for explicit custom-host trust. Native
upgraded sockets keep a separate capacity slot until the client connection closes.

Native cancellation keeps an empty, bounded replay placeholder until a valid terminal.
The ordered `<turn_aborted>` notice and readable partial history can then continue
without replaying unfinished thinking or tools. Missing relay-side Claude credentials
return 503 so native Codex does not refresh its unrelated OpenAI login.
