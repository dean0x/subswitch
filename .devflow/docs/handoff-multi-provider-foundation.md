# Handoff: Multi-Provider Foundation — Phase A

**Task ID**: feat/multi-provider-foundation  
**Branch**: feat/multi-provider-foundation  
**Base**: feature/add-model-family-aliases-to-subswitch  
**Test count at completion**: 392 (389 baseline + 3 new)

---

## What Was Changed and Where

### `src/models.ts`
- Added `export const PROVIDER_IDS = ["codex"] as const` (line 10)
- Added `export type ProviderId = (typeof PROVIDER_IDS)[number]` (line 17)
- Added required `provider: ProviderId` field to `ModelEntry` interface (between `id` and `family`)
- Set `provider: "codex"` on all four `MODEL_REGISTRY` entries:
  - `gpt-5.6-sol`, `gpt-5.6-terra`, `gpt-5.6-luna`, `gpt-5.5`

No imports were added; the one-way edge (`config.ts` → `models.ts`) is intact.

### `test/integration/fake-upstreams.ts`
- Added `import type { Logger } from "../../src/logger.js"` (zero runtime cost, type-only)
- Changed `startSubswitch` signature from `(overrides)` to `(overrides, options: { logger?: Logger } = {})`
- Inside `startSubswitch`, after `buildDeps`, splices the injected logger if provided:
  ```ts
  const deps = buildDeps(configResult.value.config);
  const finalDeps = options.logger !== undefined ? { ...deps, logger: options.logger } : deps;
  const server = createProxyServer(finalDeps);
  ```
  The sub-components (CodexHandler, AnthropicForwarder) still use the original logger from
  `buildDeps`. Only `createProxyServer`'s request_complete / request_failed logging uses the
  injected logger. This is the right scope — later phases assert on those server-level events.

### `test/integration/harness.test.ts` (new)
Two tests verifying logger injection:
1. `injected logger receives a request_complete event for every request` — uses
   `GET /__subswitch/health` (locally handled, no upstream needed) and asserts the injected
   logger captures `event="request_complete"`, `fields.path="/__subswitch/health"`,
   `fields.status=200`.
2. `default (no logger option) still works` — regression guard that existing call sites
   without a second argument still compile and run.

### `test/integration/cli.test.ts`
- Fixed env precedence in `runCli` (line ~47). Changed from:
  ```ts
  env: { ...env, NO_COLOR: "1" },   // NO_COLOR hardcoded last — caller cannot override
  ```
  to:
  ```ts
  env: { NO_COLOR: "1", ...env },   // default stays "1"; caller-supplied env wins
  ```
  The default is preserved (`env` defaults to `process.env` which has no `NO_COLOR`), but
  a caller can now pass `env: { ...process.env, NO_COLOR: undefined }` to unset it.

### `test/unit/discovery.test.ts` (new)
One test (`test-file discovery`): uses `readdir({ recursive: true })` (per ADR-004) on
`test/unit/` and `test/integration/` and asserts no `*.test.ts` file has a path separator
in its relative name. Fails immediately if someone puts a test in a subdirectory.

### `test/unit/models.test.ts`
All synthetic `ModelEntry` objects in tests updated to include `provider: "codex"` to
satisfy the now-required field. 14 synthetic registry entries across resolution, alias
derivation, scoping, normalizeModelList, and pin-pins tests.

---

## `npm test` Discovery Constraint (H4)

The test command in `package.json` is:
```
"test": "node --import tsx --test \"test/unit/*.test.ts\" \"test/integration/*.test.ts\""
```

**This glob is non-recursive.** New test files MUST be placed directly in:
- `test/unit/` — for unit tests
- `test/integration/` — for integration tests

A file at `test/integration/subdir/foo.test.ts` will silently never run and the suite
will still report green. The discovery guard in `test/unit/discovery.test.ts` will catch
this at CI time.

**Correct placement for future phases:**
- Phase B (routing table): `test/unit/routing-table.test.ts` or add to `test/unit/models.test.ts`
- Phase C (provider handler abstraction): `test/unit/provider-handler.test.ts`
- Phase D+ (new provider integration): `test/integration/<provider>.test.ts`

---

## `startSubswitch` Logger-Injection Signature

```ts
export const startSubswitch = async (
  overrides: Record<string, unknown>,
  options: { logger?: Logger } = {},
): Promise<SubswitchInstance>
```

**Usage example** (typical pattern for later phases that assert on routing events):

```ts
import type { LogLevel, LogFields } from "../../src/logger.js";
import { startSubswitch } from "./fake-upstreams.js";

type LogEntry = { level: LogLevel; event: string; fields: LogFields | undefined };
const captured: LogEntry[] = [];

const subswitch = await startSubswitch(
  {
    anthropic: { baseUrl: anthropicFake.url },
    codex: { authFile: authFile, baseUrl: codexFake.url },
  },
  {
    logger: {
      log: (level, event, fields) => { captured.push({ level, event, fields }); },
    },
  },
);

// After a request:
const completion = captured.find((e) => e.event === "request_complete");
assert.equal(completion?.fields?.route, "codex:messages");
assert.equal(completion?.fields?.model, "gpt-5.6-sol");
```

**Key field set** (from `createProxyServer` in `src/server.ts` line 123):
- `event`: always `"request_complete"`, level `"info"`
- `fields.path`: URL pathname
- `fields.route`: `"anthropic"` | `"codex:messages"` | `"codex:count_tokens"`
- `fields.model`: the as-requested model name (alias, not canonical) — may be undefined
- `fields.status`: HTTP status code
- `fields.latencyMs`: wall-clock latency

Note: `fields.model` is the **as-requested** name (what the client typed, e.g. `"sol"`),
not the resolved canonical. This is by design for operator grepping.

---

## `runCli` Env-Precedence Behaviour

`runCli` in `test/integration/cli.test.ts` now uses `{ NO_COLOR: "1", ...env }`:
- Default: `env = process.env` (no `NO_COLOR`), so the default `NO_COLOR: "1"` applies.
  All existing CLI tests keep colours off without change.
- Override: pass `env: { ...process.env, NO_COLOR: undefined }` (or any explicit value)
  and the spread wins, replacing the default.

This unblocks a later phase's `models --json` tests that need `FORCE_COLOR`/no-`NO_COLOR`
to exercise colour-off/colour-on branches.

---

## Surprises and Corrections Relative to the Plan

1. **`runCli` is in `test/integration/cli.test.ts`, not `test/unit/cli.test.ts`**
   The plan references "around line 48 of `test/unit/cli.test.ts`". The file is at
   `test/integration/cli.test.ts` (line 46). There is no `test/unit/cli.test.ts`.
   The fix was applied to the correct location.

2. **`provider` field required TypeScript updates in models tests**
   The plan's `ModelEntry` change makes `provider` required. All 14 synthetic `ModelEntry`
   objects in `test/unit/models.test.ts` needed `provider: "codex"` added. No functional
   change — purely satisfying the type constraint. The `typecheck` script caught zero errors
   after these updates.

3. **`startSubswitch` logger splicing scope**
   The injected logger only covers `createProxyServer`'s log calls (`request_complete`,
   `request_failed`). Sub-components (`CodexHandler`, `AnthropicForwarder`) still log to
   the original logger from `buildDeps` (which is silenced by `logLevel: "error"`). This
   is the right scope for later phases: routing-level events are in `createProxyServer`.
   If a later phase needs to observe e.g. codex-handler-level events, the injection would
   need to be threaded into `buildDeps` instead — which would be a Phase C-level change.

4. **H4 guard uses `setImmediate` wait pattern**
   The harness test for H1 awaits `new Promise<void>((resolve) => setImmediate(resolve))`
   after the HTTP response to allow the `res.on("close")` callback to fire before asserting.
   This is necessary because `fetch` resolves when the response body is fully consumed, which
   may be before Node's http server fires the `close` event internally. The `setImmediate`
   defers to after the current I/O event queue drains, giving the close event time to run.

5. **Current `MODEL_REGISTRY` entries** (confirmed, unchanged):
   ```ts
   { id: "gpt-5.6-sol",   provider: "codex", family: "sol",   gen: [5, 6] }
   { id: "gpt-5.6-terra", provider: "codex", family: "terra", gen: [5, 6] }
   { id: "gpt-5.6-luna",  provider: "codex", family: "luna",  gen: [5, 6] }
   { id: "gpt-5.5",       provider: "codex",                  gen: [5, 5] }
   ```

---

## Current Test Count

**392 tests**, all passing:
- 389 from the baseline on `feature/add-model-family-aliases-to-subswitch`
- +2 from `test/integration/harness.test.ts` (H1 logger injection)
- +1 from `test/unit/discovery.test.ts` (H4 discovery guard)

Decisions applied: ADR-004 (`readdir({ recursive: true })`), ADR-005 (provider required,
no defaulting that weakens the exact-membership invariant).

---

# Handoff: Multi-Provider Foundation — Phase B

**Task ID**: feat/multi-provider-foundation  
**Branch**: feat/multi-provider-foundation  
**Commit**: 3b77516  
**Test count at completion**: 430 (392 baseline + 38 new)

---

## What Was Changed and Where

### `src/models.ts` (additive only — no deletions)

New types exported (lines inserted before Registry section):

```ts
export interface ResolvedModel {
  readonly id: string;
  readonly provider: ProviderId;
  readonly family?: string;   // omitted when entry has no family
}

export type FamilyResolution =
  | { readonly kind: "unique"; readonly model: ResolvedModel }
  | { readonly kind: "ambiguous"; readonly providers: readonly ProviderId[] };

export interface RoutingTable {
  readonly byId: ReadonlyMap<string, ProviderId>;           // exact-membership set (ADR-005)
  readonly byFamily: ReadonlyMap<string, FamilyResolution>;
  readonly byQualified: ReadonlyMap<string, ResolvedModel>; // "codex:gpt-5.6-sol" and "codex:sol"
  readonly byAlias: ReadonlyMap<string, ResolvedModel>;
}

export interface RoutingTableBuild {
  readonly table: RoutingTable;
  readonly rejectedAliases: readonly { readonly alias: string; readonly target: string }[];
  readonly ambiguousFamilies: readonly {
    readonly family: string;
    readonly providers: readonly ProviderId[];
  }[];
  readonly reservedNameEntries: readonly string[];
}

export type ModelResolution =
  | { readonly kind: "resolved"; readonly target: ResolvedModel }
  | { readonly kind: "ambiguous"; readonly name: string; readonly providers: readonly ProviderId[] }
  | { readonly kind: "unresolved" }
  | { readonly kind: "unknown_qualifier"; readonly qualifier: string };
```

New functions exported (inserted before `formatModelsReport`):

- `buildRoutingTable(registry, aliasesByProvider)` → `RoutingTableBuild`
- `resolveModel(table, name)` → `ModelResolution`

---

## `unknown_qualifier` vs `unresolved` (F5 decision)

**Choice**: distinct arm `{ kind: "unknown_qualifier"; qualifier: string }` in `ModelResolution`.

**Why**: Phase D's `decideRoute` needs to emit two distinct diagnostics:
- `unresolved` → "unknown model name" (typo in model name, or valid-provider qualified name with bad id)
- `unknown_qualifier` → "unknown provider 'X'" (colon-separated name where the prefix isn't in PROVIDER_IDS)

A single `unresolved` with an optional `qualifier` field was considered but rejected:
`exactOptionalPropertyTypes: true` would require conditional spreads everywhere, and the semantic difference is large enough to warrant a discriminated union arm. A narrowing `if (r.kind === "unknown_qualifier")` is self-documenting at the Phase D call site.

The qualifier field carries the unrecognised prefix (e.g. `"kimee"` for `"kimee:k2"`), giving enough context for a human-readable error without Phase D having to re-parse the name.

---

## Synthetic-Registry Test Helper Location

File: `/Users/dean/Sandbox/croxy/test/unit/routing-table.test.ts`

The single cast is in the `foreignEntry` helper at the top of the file (around line 30):

```ts
const foreignEntry = (
  id: string,
  foreignProvider: string,
  overrides: Partial<Omit<ModelEntry, "id" | "provider">> = {},
): ModelEntry => ({
  id,
  provider: foreignProvider as ProviderId,  // ← THIS CAST — delete when second provider lands
  gen: [5, 6],
  ...overrides,
});
```

**To delete when a second provider lands**: remove `foreignEntry` and all callers (three test blocks
in the "Contested family" suite, "F13" multi-provider block, and one multi-provider aliases block).
Update `aliasesByProvider` construction in those tests to use the real two-provider type.

---

## Perf Test Outcome (P1)

**Asserted** at ≤ 1.00 µs/call (20× the ~0.05 µs baseline, for robust CI behaviour).  
**Measured**: ~0.083 µs/call over 100,000 iterations (warm-up: 1,000 calls before timing).

The measured value is comfortably within both the original 0.10 µs target AND the asserted 1.00 µs CI
budget. The generous CI margin (20×) absorbs cold JIT and context-switching jitter while still catching
catastrophic regressions (e.g. an accidental `Array.find` inside the hot path would push it to ~5 µs).

---

## Mutation Spot-Check Table

| Test | Rule targeted | Mutation that would cause failure | Verified |
|------|--------------|-----------------------------------|---------|
| F4: exact id beats alias | Rule 1 (byId before byAlias) | Remove byId lookup in resolveModel | ✓ separate spot-check test |
| F9: retired not in family | Family derivation filters retired | Remove `retired === true` guard in perProviderFamilyBest loop | ✓ separate spot-check test |
| One-hop: `a → b` stops | No transitive alias follow | Replace one-hop byAlias.get with recursive chase | ✓ separate spot-check test |
| Prototype pollution guard | Object.hasOwn in buildRoutingTable | Replace Object.hasOwn with direct bracket access | ✓ separate spot-check test |
| F2: newest non-preview/retired | compareGen in perProviderFamilyBest | Replace `> 0` with `>= 0` (would make last-declared win) | ✓ implicit in F2 tests |
| unknown_qualifier | Colon check in rule 3 | Remove PROVIDER_IDS.includes check → all coloned names become unresolved | ✓ F5 test |

All spot-check tests are in the "Mutation spot-check" describe blocks at the bottom of
`test/unit/routing-table.test.ts`.

---

## Contradictions Relative to the Plan

None significant. One implementation detail clarified:

1. **byQualified contains both "provider:id" and "provider:family" entries.**
   The spec didn't say explicitly whether byQualified included family-qualified lookups
   (`codex:sol`). I added them (per-provider family winners only, for unique families),
   making rule 3 a pure table lookup without secondary family resolution logic in `resolveModel`.
   This simplifies the resolver and makes "codex:sol" first-class.

2. **byId stores ProviderId, not ResolvedModel.**
   Rule 1 in resolveModel does a secondary byQualified lookup to get the full ResolvedModel
   (with optional family). This is O(1) and avoids duplicating ResolvedModel objects in byId.
   A defensive fallback `{ id: name, provider: exactProvider }` handles the edge case of
   an id in byId that isn't in byQualified (not possible given current build logic, but
   protects against a future bug in buildRoutingTable).

---

## Current Test Count

**430 tests**, all passing:
- 392 from Phase A completion
- +38 from `test/unit/routing-table.test.ts` (Phase B)

Decisions applied: ADR-005 (byId as exact-membership set; resolution before dispatch),
PF-007 (rejected aliases cover both keys AND targets).

## Integration Points for Phase C/D

### Imports needed
```ts
import {
  buildRoutingTable,
  resolveModel,
  MODEL_REGISTRY,
  PROVIDER_IDS,
  type RoutingTable,
  type RoutingTableBuild,
  type ModelResolution,
  type ResolvedModel,
} from "./models.js";
```

### `aliasesByProvider` shape
```ts
// Current (single provider):
const aliasesByProvider: Record<ProviderId, Record<string, string>> = {
  codex: config.codex?.aliases ?? {},
};
```
`Record<ProviderId, ...>` is a completeness proof — adding a second provider to PROVIDER_IDS
produces a compile error at this call site until the second provider's aliases are wired.

### Wire-up sequence (Phase C/D)
1. Call `buildRoutingTable(MODEL_REGISTRY, aliasesByProvider)` once at startup → store `table`
2. At request time: `const resolution = resolveModel(table, requestedModelName)`
3. Switch on `resolution.kind`:
   - `"resolved"` → dispatch to `resolution.target.provider` handler
   - `"ambiguous"` → 400 with provider list
   - `"unresolved"` → fall through to Anthropic (or 404 depending on phase)
   - `"unknown_qualifier"` → 400 "unknown provider '${resolution.qualifier}'"
4. Phase D replaces `makeModelResolver` / `normalizeModelList` usage in `router.ts` / `config.ts`

### Do NOT rename yet
`isAnthropicModelName` is renamed to `isReservedAnthropicName` in Phase C — the task doc
says "do not rename it here."

---

# Handoff: Multi-Provider Foundation — Phase C

**Task ID**: feat/multi-provider-foundation
**Branch**: feat/multi-provider-foundation
**Commits**: 9b60fe8 → 3174119 (6 commits)
**Test count at completion**: 438 (430 baseline + 8 new)

---

## What Was Changed and Where

### Step 4a — Two Pure Renames (commit 9b60fe8)

**`src/errors.ts`**: `codexStatusToAnthropicError` → `upstreamStatusToAnthropicError`
- The function maps HTTP status codes to Anthropic error types with zero Codex-specific branches.
  The old name was simply wrong.
- Updated call sites: `src/codex-handler.ts` (import + 1 usage), `test/unit/errors.test.ts`
  (import + describe block name + 8 assertions).
- `proxyErrorToAnthropic` internal call also renamed.

**`src/models.ts`**: `isAnthropicModelName` → `isReservedAnthropicName`
- The regex is **unchanged** (`/^(inherit|sonnet|opus|haiku|claude-)/i`).
- Rename restates it as a one-way exclusion (names Claude Code's main thread might send must
  never be resolvable in the routing table), not a provider classifier.
- Updated the JSDoc accordingly.
- Updated call sites: `src/config.ts` (4 usages), `src/agent-scan.ts` (1 usage),
  `src/models.ts` internal (2 usages in buildRoutingTable).

### Step 4b — Extract `buildInstructions` to `anthropic-parse.ts` (commit 4286b17)

**New file `src/anthropic-parse.ts`**: Contains `buildInstructions` (text extraction from
Anthropic `system` field). Also contains a private `textOfBlocks` helper.
- Imports only `AnthropicRequest` from `anthropic-wire-types.ts` (no Codex dependencies).
- `src/codex-request.ts`: now imports `buildInstructions` from `anthropic-parse.ts`; the
  local definition was removed. The function is no longer exported from codex-request.ts.
- `src/conversation-key.ts`: import changed from `./codex-request.js` to `./anthropic-parse.js`.

**New pinned test** in `test/unit/conversation-key.test.ts`:
- Pins the exact key value for `model="gpt-5.5"`, no system, first user message `"hello"`.
- Expected: `"5002ec0c-e01d-789b-8070-b44a7563fae2"`. Catches any change to hash input,
  UUID encoding, or capBytes logic — those changes would silently destroy cache affinity.

### Step 4c — Split `wire-types.ts` (commit 34f3cef)

**New file `src/anthropic-wire-types.ts`**: Contains all Anthropic Messages API schemas:
- `AnthropicToolSchema`, `AnthropicMessageSchema`, `AnthropicRequestSchema`
- Types: `AnthropicRequest`, `AnthropicMessage`, `AnthropicTool`
- `ModelPeekSchema` (200-char bound; log-injection guard)

**`src/wire-types.ts`** now contains only:
- Responses API schemas (`ResponsesEventEnvelopeSchema`, `ResponsesOutputItemSchema`,
  `ResponsesDeltaEventSchema`, `ResponsesResponseObjectSchema`, `ResponsesLifecycleEventSchema`,
  `ResponsesErrorEventSchema`) — all `.passthrough()` preserved deliberately
- OAuth/auth schemas (`AuthTokensSchema`, `AuthFileSchema`, `TokenResponseSchema`)

Updated importers:
- Src: `anthropic-parse.ts`, `conversation-key.ts`, `codex-request.ts`, `codex-handler.ts`, `server.ts`
- Tests: `codex-request.test.ts`, `conversation-key.test.ts`, `wire-types.test.ts`
- `codex-response.ts` continues importing from `wire-types.ts` (Responses schemas only)
- `codex-auth.ts` continues importing from `wire-types.ts` (auth schemas only)

### Step 3 — Extract `provider-transport.ts` + Parameterize Strings (commit 261850f)

**New file `src/provider-transport.ts`**: Provider-neutral HTTP transport helpers:
- `respondJson(res, status, body, extraHeaders?)` — generic JSON response
- `respondProxyError(res, error)` — maps ProxyError → Anthropic HTTP response
- `readBoundedText(body, maxBytes)` — reads bounded text from WHATWG body stream

These three functions were previously defined as module-level constants inside `createCodexHandler`.
They are now exported from `provider-transport.ts` and imported by `codex-handler.ts`.
Logic is byte-identical; only the source location moved.

**`src/codex-handler.ts`** changes:
- Removed `respondJson`, `respondProxyError`, `readBoundedText` local definitions
- Added `readonly providerName?: string` to `CodexHandlerDeps` (default `"codex"`)
- All 7 client-visible error strings now use `providerName` via template literals:
  - `"codex request timed out"` → `` `${providerName} request timed out` ``
  - `"codex upstream unreachable"` → `` `${providerName} upstream unreachable` ``
  - `"codex authentication failed after refresh — run \`codex login\`"` → `` `${providerName} authentication failed after refresh — run \`${providerName} login\`` ``
  - `"codex upstream error (N)"` → `` `${providerName} upstream error (N)` ``
  - `"codex upstream returned an empty body"` → `` `${providerName} upstream returned an empty body` ``
  - `"codex stream interrupted"` (SSE) → `` `${providerName} stream interrupted` ``
  - `"codex stream interrupted"` (ProxyError) → `` `${providerName} stream interrupted` ``
- Passes `providerName` to `createAnthropicSseTranslator` and `aggregateFrames`

**`src/codex-response.ts`** changes:
- `TranslatorOptions` gains `readonly providerName?: string` and `readonly messageIdFallback?: string`
- Resolved at construction time (not per-chunk) to preserve monomorphic hot path
- `msgIdFallback = options.messageIdFallback ?? "msg_codex"` — used in `ensureStarted`
- `"codex response failed"` → `` `${providerName} response failed` ``
- `"codex stream error"` → `` `${providerName} stream error` ``
- `aggregateFrames(frames, providerName = "codex")` — optional second parameter
- `"codex upstream error"` → `` `${providerName} upstream error` ``
- `"codex stream ended before producing a message"` → `` `${providerName} stream ended before producing a message` ``

**Proof of byte-identity for Codex**: All defaults are `"codex"` / `"msg_codex"`. Every
existing string is byte-identical to the previous hardcoded values. `git diff
test/integration/codex-leg.test.ts test/integration/passthrough.test.ts` is empty.

Internal log event names (`codex_sse_unparseable_data`, `codex_sse_event_ignored`,
`codex_upstream_401_refreshing`, `codex_translate_warning`, `codex_effort_applied`,
`codex_upstream_error`, `codex_stream_interrupted`) were intentionally NOT parameterized —
they are internal observability identifiers for the Codex leg, not client-visible strings.

### Bounded-Resource Fix 1 — writeFrame Drain Timeout (commit 77c7d64)

**`src/codex-handler.ts`** `writeFrame` now races `drain` and `close` against
`controller.signal.addEventListener("abort", onAbort, { once: true })`.

A `cleanup()` helper removes all three listeners atomically on whichever fires first.
Before this fix: a client that stopped reading without closing held the handler open past
`requestTimeoutMs`. After: the controller abort unblocks `writeFrame` and the `finally`
block runs `cleanup()`.

New test file: `test/unit/write-frame-abort.test.ts` (5 tests):
- fast path (write returns true)
- abort signal fires while waiting for drain
- drain fires before abort
- close fires (client disconnect)
- listener cleanup verified (listenerCount = 0 after abort)

### Bounded-Resource Fix 2 — SSE Parser O(n) (commit 3174119)

**`src/codex-response.ts`** `createSseParser` now tracks `scanStart = Math.max(0, prevLen - 3)`.

`prevLen` is captured before appending the new chunk. On the initial search, `buffer.slice(scanStart).search(...)` scans only the new bytes plus 3-byte overlap. After consuming an event (buffer trimmed), the next search is from 0 as before. Total complexity is O(bytes) rather than O(S²/C).

`buffer.slice(scanStart)` creates a copy of ~chunk-sized data, not the full buffer.

New tests in `test/unit/codex-response.test.ts`:
- `\r\n\r\n` separator straddling a chunk boundary (correctness of 3-byte overlap)
- 64 KB payload in 1-byte chunks (regression guard for O(S²/C) pattern)

---

## Module Boundaries and Export Surfaces

### `src/anthropic-wire-types.ts` (new)
```ts
export { AnthropicToolSchema, AnthropicMessageSchema, AnthropicRequestSchema }
export type { AnthropicRequest, AnthropicMessage, AnthropicTool }
export { ModelPeekSchema }
```
No Codex dependencies. Safe to import from any future provider.

### `src/anthropic-parse.ts` (new)
```ts
export { buildInstructions }
// buildInstructions(system: AnthropicRequest["system"]): string | undefined
```
Imports from `anthropic-wire-types.ts` only. Safe to import from any future provider.

### `src/provider-transport.ts` (new)
```ts
export { respondJson, respondProxyError, readBoundedText }
```
Imports from `errors.ts` only. Safe to import from any future provider handler.

### `src/wire-types.ts` (modified — Responses + Auth schemas only)
```ts
export { ResponsesEventEnvelopeSchema, ResponsesOutputItemSchema,
         ResponsesOutputItemEventSchema, ResponsesDeltaEventSchema,
         ResponsesResponseObjectSchema, ResponsesLifecycleEventSchema,
         ResponsesErrorEventSchema }
export { AuthTokensSchema, AuthFileSchema, AuthFile,
         TokenResponseSchema, TokenResponse }
```
All Responses schemas are `.passthrough()`. A future provider importing these
must also use a Responses API backend. If a new provider has a different wire format,
it should NOT import from `wire-types.ts`.

### `src/codex-handler.ts` (modified)
`CodexHandlerDeps` now has `readonly providerName?: string` (default `"codex"`).
`createAnthropicSseTranslator` now accepts `providerName` and `messageIdFallback` in options.
`aggregateFrames` now accepts optional `providerName` (default `"codex"`).

---

## Things Left for Phase D

Per the explicit "NOT in this phase" list:
- `ProviderHandler` interface, the `providers` map, `resolve` on `ServerDeps`
- Moving `ReasoningCache`/`CodexAuthManager` into `createCodexProvider`
- `AnthropicFrameEmitter` (deferred until a second provider needs it)
- Deleting `codex.models`, `Route`/`decideRoute`, config restructure (Phase E)
- `provider-auth.ts` was NOT created — nothing genuinely portable in auth exists yet
  (auth is Codex-specific: `CodexAuthManager`, `CodexCredentials`, OAuth token endpoint).
  The interface for a second provider's auth belongs in Phase D's `ProviderHandler`.

Additional note from FEATURE_KNOWLEDGE observation: `readBoundedText` caps at 2048 bytes,
so a longer error body is truncated mid-document and **always** fails `JSON.parse`. Any future
multi-shape error parser must treat truncation as an explicit signal rather than a parse failure.
(Noted in the handoff per FEATURE_KNOWLEDGE guidance; not a Phase C fix.)

---

## Frozen Oracle File Confirmation

```
git diff test/integration/codex-leg.test.ts test/integration/passthrough.test.ts
```
Output: empty. Both files are byte-identical to their state before Phase C.

---

## Current Test Count

**438 tests**, all passing:
- 430 from Phase B completion
- +1 pinned conversation key value (test/unit/conversation-key.test.ts)
- +5 writeFrame abort race (test/unit/write-frame-abort.test.ts)
- +2 SSE parser correctness under scanStart optimization (test/unit/codex-response.test.ts)

Decisions applied:
- ADR-003 (sessionId derived once before retry loop — preserved in handler)
- PF-005 (buildHeaders constants preserved byte-identical)
- "no speculative abstraction" principle (provider-auth.ts not created; AnthropicFrameEmitter deferred)

---

# Handoff: Multi-Provider Foundation — Phase D

**Task ID**: feat/multi-provider-foundation
**Branch**: feat/multi-provider-foundation
**Commits**: ff2b666 → af982ec (4 commits)
**Test count at completion**: 440 (438 baseline + 2 new)

---

## What Was Changed and Where

### `src/provider-auth.ts` (new — commit ff2b666)

Defines the auth seam for future providers (5c):

```ts
export interface ProviderCredentials<P extends ProviderId> {
  readonly provider: P;                                  // phantom brand
  readonly headers: Readonly<Record<string, string>>;
}

export interface ProviderAuth<P extends ProviderId> {
  getCredentials(): Promise<Result<ProviderCredentials<P>, ProxyError>>;
  forceRefresh(): Promise<Result<ProviderCredentials<P>, ProxyError>>;
  readonly refreshable: boolean;                         // false ⇒ skip retry
}
```

The phantom `provider` brand makes cross-provider credential injection a compile
error. `CodexAuthManager` does NOT yet implement `ProviderAuth<"codex">` — that
wiring is Phase E. The interfaces are defined now so the brand check is in place
before a second provider is added.

Decisions applied: ADR-002 (no API keys; subscription OAuth per leg).

### `src/provider-handler.ts` (new — commit 4d4520a)

Defines the handler contract every provider must satisfy:

```ts
export interface ProviderHandler {
  handleMessages(
    req: IncomingMessage, res: ServerResponse,
    rawBody: Buffer, parsed: unknown, canonicalModel: string,
  ): Promise<void>;
  handleCountTokens(req: IncomingMessage, res: ServerResponse, rawBody: Buffer): void;
}
```

The signature difference from the old `CodexHandler.handleMessages` is the new
`parsed: unknown` parameter (the P4 contract). `rawBody` is kept for providers that
forward it untouched (Content-Length) and for `estimateTokens`.

### `src/codex-handler.ts` (modified — commit 4d4520a)

`CodexHandler.handleMessages` gains `parsed: unknown` before `canonicalModel`.
The try/catch `JSON.parse(rawBody)` block is removed from the implementation.
`_rawBody` is now unused in this method and is prefixed with `_`.
`createCodexHandler` returns `CodexHandler`, which is structurally compatible with
`ProviderHandler` (TypeScript structural subtyping, no explicit `extends` needed).

### `src/server.ts` (modified — commit 114c03f)

**`ServerDeps` new shape:**
```ts
export interface ServerDeps {
  readonly config: Config;
  readonly logger: Logger;
  readonly forwardAnthropic: AnthropicForwarder;              // privileged default leg
  readonly providers: Readonly<Record<ProviderId, ProviderHandler>>;
  readonly resolve: (name: string) => ModelResolution;        // built once in buildDeps
}
```
`codex: CodexHandler` is removed. `providers` and `resolve` are added.

**`createCodexProvider` (new private factory):**
```ts
const createCodexProvider = (config: Config, logger: Logger): ProviderHandler =>
  createCodexHandler({
    config, logger,
    auth: new CodexAuthManager({ store: createFsAuthFileStore(config.codex.authFile), ... }),
    cache: new ReasoningCache(config.reasoningCache.maxEntries, config.reasoningCache.maxBytes),
  });
```
`ReasoningCache` and `CodexAuthManager` construction moved here from `buildDeps`.
They are no longer unconditionally allocated for every process.

**`buildDeps` changes:**
- Calls `createCodexProvider(config, logger)` → `providers.codex`
- Calls `buildRoutingTable(MODEL_REGISTRY, aliasesByProvider)` once
- Sets `resolve: (name) => resolveModelFromTable(table, name)`
- Emits `warn codex_base_url_override_detected` when `config.codex.baseUrl` host
  ≠ `"chatgpt.com"` (5e). Uses existing logger field keys only — FIELD_KEYS unchanged.
- `aliasesByProvider: Record<ProviderId, Record<string, string>> = { codex: config.codex.aliases }`
  — explicit type annotation ensures adding a ProviderId without its aliases is a compile error.

**`createProxyServer` changes:**
- `peekModel(body: Buffer)` → `peekModel(parsed: unknown)` — takes the already-parsed
  JSON value, no `JSON.parse` call inside.
- `JSON.parse` is called exactly once in `dispatch` before `peekModel`.
- `deps.codex.handleMessages` → `deps.providers.codex.handleMessages(req, res, body.value, parsedBody, canonical)`
- `canonical!` non-null assertion removed; replaced by a defensive guard that falls
  through to Anthropic (documents the invariant instead of asserting).
- `deps.codex.handleCountTokens` → `deps.providers.codex.handleCountTokens`

**Which resolver drives production routing at Phase D end:**
The OLD `makeModelResolver` path inside `createProxyServer` still drives the routing
predicate. `deps.resolve` (Phase B resolver) is present in deps and called by the
credential-leak test, but it does NOT yet gate the routing decision. Phase E flips it.

### Tests added

**`test/unit/provider-handler.test.ts`** (commit af982ec):
P4 test. Passes `parsedBody = null` (fails schema → 400) alongside `rawBody` that IS
a valid AnthropicRequest (would succeed schema → 401 from stub auth if re-parsed).
Status code is the discriminator: 400 proves handler used `parsedBody` directly.

**`test/integration/credential-leak.test.ts`** (commit af982ec):
Row 5 of the credential-leak matrix. Sends a `claude-*` model request (routes to
Anthropic) and verifies the Anthropic upstream receives no Codex-specific headers
(`chatgpt-account-id`, `openai-beta`, `originator`, `session_id`) and that the
`authorization` header is the client's `sk-ant-*` token, not a Codex JWT.
Row 1 (sk-ant-* never reaches Codex) is already pinned in the frozen oracle at
`codex-leg.test.ts:108–110` — that file was NOT touched.

---

## Interface Shapes (final)

### `ServerDeps`
```ts
export interface ServerDeps {
  readonly config: Config;
  readonly logger: Logger;
  readonly forwardAnthropic: AnthropicForwarder;
  readonly providers: Readonly<Record<ProviderId, ProviderHandler>>;
  readonly resolve: (name: string) => ModelResolution;
}
```

### `ProviderHandler`
```ts
export interface ProviderHandler {
  handleMessages(req, res, rawBody: Buffer, parsed: unknown, canonicalModel: string): Promise<void>;
  handleCountTokens(req, res, rawBody: Buffer): void;
}
```

### `ProviderAuth<P>`
```ts
export interface ProviderAuth<P extends ProviderId> {
  getCredentials(): Promise<Result<ProviderCredentials<P>, ProxyError>>;
  forceRefresh(): Promise<Result<ProviderCredentials<P>, ProxyError>>;
  readonly refreshable: boolean;
}
```

### `ProviderCredentials<P>`
```ts
export interface ProviderCredentials<P extends ProviderId> {
  readonly provider: P;  // phantom brand
  readonly headers: Readonly<Record<string, string>>;
}
```

---

## Answers to Handoff Checklist

**Which resolver drives production routing at Phase D end:**
The OLD `makeModelResolver` + `decideRoute` + `config.codex.models` path inside
`createProxyServer`. `deps.resolve` exists and is tested but does NOT yet gate routing.

**Where `buildRoutingTable` is called and proof it is called once:**
Called once in `buildDeps` (line ~71 of the new server.ts). `buildDeps` is called once
at startup. `createProxyServer` closes over `deps` but does not rebuild the table.
The `resolve` closure captures `table` by reference — structurally guaranteed to be
called at most once per process lifetime.

**How P4 was tested:**
Behavioral (not spy). Pass `parsedBody = null` to `handleMessages`. If handler uses
`parsedBody`: Zod schema fails on null → 400 response. If handler calls
`JSON.parse(rawBody)`: Zod schema succeeds on valid rawBody → auth stub fails → 401.
Assert `statusCode === 400`. Clean, no spy machinery, catches regression precisely.

**Frozen oracle file diff:**
`git diff test/integration/codex-leg.test.ts test/integration/passthrough.test.ts`
Output: empty. Both files are byte-identical to their state before Phase D.

**`provider-auth.ts` created:**
Yes. Contains `ProviderCredentials<P>` and `ProviderAuth<P>`. `CodexAuthManager` does
NOT yet implement `ProviderAuth<"codex">` — wiring is Phase E. The interfaces exist so
the phantom brand is available when a second provider is wired.

**Contradictions relative to the plan:**
None significant.
- `CodexHandler` is not explicitly declared as `extends ProviderHandler`; structural
  compatibility suffices in TypeScript (same method signatures).
- `provider-auth.ts` does not wire `CodexAuthManager` to `ProviderAuth<"codex">` in
  this phase — consistent with the plan's statement that Phase D is pre-wire-in.

---

## Current Test Count

**440 tests**, all passing:
- 438 from Phase C completion
- +1 P4 unit test (test/unit/provider-handler.test.ts)
- +1 credential-leak Row 5 integration test (test/integration/credential-leak.test.ts)

Decisions applied:
- ADR-002 (subscription OAuth per leg; createCodexProvider isolates Codex credentials)
- ADR-003 (sessionId outside retry loop — preserved in codex-handler.ts)
- ADR-005 (buildRoutingTable called once in buildDeps; resolve closure structurally once-built)
- "no speculative abstraction" principle (ProviderAuth interfaces defined; not yet wired
  into CodexAuthManager — that is Phase E's job)

---

# Handoff: Multi-Provider Foundation — Phase E

**Task ID**: feat/multi-provider-foundation
**Branch**: feat/multi-provider-foundation
**Commits**: 165a950 → 5331b26 (5 commits)
**Test count at completion**: 400 (440 baseline − 46 deleted + 6 new)

---

## What Was Changed and Where

### Step 6a/6c — `src/router.ts` (complete rewrite)

`Route` now has 4 arms:
```ts
export type Route =
  | { readonly kind: "provider"; readonly provider: ProviderId; readonly model: string; readonly endpoint: "messages" | "count_tokens" }
  | { readonly kind: "anthropic" }
  | { readonly kind: "ambiguous"; readonly name: string; readonly providers: readonly ProviderId[] }
  | { readonly kind: "unknown_provider"; readonly qualifier: string };
```

`decideRoute` signature changed from `(method, path, model, codexModels[])` to `(method, path, resolution: ModelResolution)`. Performs ZERO name matching — all matching is in `resolveModel` (ADR-005).

- `unresolved` → `{ kind: "anthropic" }` (unknown name falls through to upstream)
- `ambiguous` → `{ kind: "ambiguous", name, providers }` (two providers claim the same family)
- `unknown_qualifier` → `{ kind: "unknown_provider", qualifier }` (prefix not in PROVIDER_IDS)
- `resolved` → `{ kind: "provider", provider, model: target.id, endpoint }` based on pathname

### Step 6c — `src/models.ts`

Deleted: `normalizeModelList` function body (removed entirely; Phase F will clean up test references)

Added back as `@deprecated` exports for `agent-scan.ts` compat (MUST NOT touch `agent-scan.ts` — Phase F task):
```ts
/** @deprecated Phase F will remove this */
export const ALL_MODEL_IDS: readonly string[] = MODEL_REGISTRY.map((e) => e.id);
/** @deprecated Phase F will remove this — use resolveModel + buildRoutingTable instead. */
export const makeModelResolver = (registry, routable, overrides) => { ... }
```

### Step 6d/6e — `src/config.ts` (complete rewrite)

**On-disk format (`FileConfigSchema`)** now uses `providers.codex.*`:
```json
{
  "providers": { "codex": { "baseUrl": "...", "aliases": {} } }
}
```

**Runtime `Config` interface** keeps `codex.*` for `doctor.ts` backward compat:
```ts
export interface Config {
  readonly anthropic: {
    baseUrl, connectTimeoutMs, streamIdleTimeoutMs, maxUpstreamSockets
  };
  readonly codex: {
    baseUrl, oauthTokenUrl, authFile, userAgent, aliases,
    models: readonly string[],          // DERIVED from MODEL_REGISTRY; never user-configurable
    reasoningCache: { maxEntries, maxBytes },
    requestTimeoutMs, streamIdleTimeoutMs, maxSseEventBytes,
  };
  readonly limits: { maxBodyBytes, pingIntervalMs };  // server-level only
}
```

`resolveConfig(file: FileConfig): Config` — pure transformation, maps `providers.codex.*` → `config.codex.*`.

**Removed**: `DEFAULT_CODEX_MODELS`, `extractRawCodexModels`, `computeCodexModelsPinned`, `codexModelsPinned` from `LoadConfigResult`.

### Step 6b/6h — `src/server.ts`

Exhaustive switch on `Route`:
```ts
switch (decision.kind) {
  case "anthropic": deps.forwardAnthropic(req, res, body.value); return;
  case "provider": {
    route = `${decision.provider}:${decision.endpoint}:${decision.model}`;   // 6h
    if (decision.endpoint === "count_tokens") { handleCountTokens; return; }
    await deps.providers[decision.provider].handleMessages(...); return;
  }
  case "ambiguous": { /* 400 naming both providers */ return; }
  case "unknown_provider": { /* 400 naming unknown qualifier */ return; }
  default: { const _exhaustive: never = decision; void _exhaustive; ... }
}
```

Removed: old `makeModelResolver` + `decideRoute(method, path, model, codexModels)` path in `createProxyServer`. The `?? model` fallback is gone.

`codex-handler.ts`: moved per-provider timeout reads from `config.limits.*` to `config.codex.{requestTimeoutMs,streamIdleTimeoutMs,maxSseEventBytes}`.

### Step 6f — `src/init.ts`, `src/cli.ts`

Deleted from `init.ts`:
- `InitOptions.codexModels`, `InitFlags.codexModel/codexModels`
- `mergeModelFlags`, `planConfigWrite` 4th models arg
- `seedWizard` model seeding logic
- Model multiselect step in `runInitInteractive`
- `InitPrompts.multiselect` from the interface

Wizard is now **2-step**: port (text) → settings target (select).

`planConfigWrite(existingJson, port, projectDir)` — 3 args, writes only `{ ...existing, port }`.

Deleted from `cli.ts`:
- `--codex-model`, `--codex-models` from `parseArgs`, `USAGE`, `INIT_FLAGS`
- `codexModel/codexModels` from init flags destructuring

---

## Test Changes

### test/unit/models.test.ts
Removed: `normalizeModelList` describe block (11 tests), "pin pins" describe block (5 tests).
Kept: `makeModelResolver`, `formatModelsReport`, prototype-pollution guard, canary tests.

### test/unit/init.test.ts
Rewritten: all `planConfigWrite` calls use 3-arg form; all `executeInit` calls drop `codexModels`; all model-flag tests removed.

### test/unit/init-wizard.test.ts
Rewritten for 2-step wizard: `ScriptedPromptsConfig` has only `textResponse + selectResponse` (no `multiselectResponse`); `InitPrompts` test double has no `multiselect`; model seeding tests removed.

### test/unit/doctor.test.ts
Updated `makeTestConfig()`:
```ts
anthropic: { baseUrl, connectTimeoutMs: 10_000, streamIdleTimeoutMs: 300_000, maxUpstreamSockets: 32 },
codex: { ..., reasoningCache: { maxEntries: 4096, maxBytes: 64M }, requestTimeoutMs: 600_000, streamIdleTimeoutMs: 300_000, maxSseEventBytes: 4M },
limits: { maxBodyBytes: 32M, pingIntervalMs: 15_000 },
```

### test/integration/codex-leg.test.ts
All config fixtures: `codex: { ... }` → `providers: { codex: { ... } }`.
Deleted: "a narrowed codex.models list" test (feature removed).

### test/integration/cli.test.ts
Updated alias test to `providers.codex.aliases` format.
Deleted: 2 `codex.models` narrowing tests.

### test/integration/credential-leak.test.ts
`codex: { authFile }` → `providers: { codex: { authFile } }`.

### test/integration/routing-behavior.test.ts (NEW)
- F7: ambiguous family → 400, both provider names in body, no upstream forwarded
- F6g: unknown_provider qualifier → 400 with known-providers list
- P2: routing table called once — 2 consecutive requests route to same codex upstream

---

## Key Constraints for Phase F

1. **Do NOT touch** `src/doctor.ts`, `src/agent-scan.ts` — Phase F task.
2. **`src/models.ts`** keeps `ALL_MODEL_IDS` and `makeModelResolver` as `@deprecated` exports for `agent-scan.ts`.
3. **`PROVIDER_IDS` stays `["codex"]`** until a second provider is added.
4. **`Config.codex.*`** (runtime shape) must remain backward compat with `doctor.ts` direct field reads.
5. **Do NOT build `AnthropicFrameEmitter`**.

## Snyk Security Findings

4 pre-existing MEDIUM findings (all pre-date Phase E):
1. `e2e/capture/codex-recorder.ts:460` — HTTP cleartext (recording tool, not production)
2. `src/server.ts:168` — HTTP cleartext (intentional local proxy architecture)
3. `src/cli.ts:306` — Path traversal (config path from user config — existing pattern)
4. `src/codex-handler.ts:283` — Error message exposure (upstream error strings in response — existing pattern)

None are newly introduced by Phase E changes.

---

## Current Test Count

**400 tests**, all passing:
- 440 from Phase D completion
- −46 deleted (normalizeModelList, pin-pins, model-flag tests, codex.models narrowing tests)
- +6 new (routing-behavior.test.ts: F7 ×2, F6g, P2; config.test.ts structure updated)

---

## Phase F Implementation Summary

**Commit**: `8e5b574`
**Test count at completion**: 409 (from 400 Phase E baseline)

### Files Created/Modified

- **`src/models.ts`** — Removed deprecated shims (`ALL_MODEL_IDS`, `makeModelResolver`); added `AliasEntry`, `ModelRow`, `AliasTableRow` types; added `buildAliasRows`, `buildModelRows` builders; updated `FormatModelsReportInput` (removed `routable`); updated `formatModelsReport` to use `buildAliasRows` and add provider column.

- **`src/config.ts`** — Removed `MODEL_REGISTRY` import; removed `codex.models` from `Config` interface and `resolveConfig`; added `maxConcurrentRequests: z.number().int().positive().default(32)` to `LimitsSchema`; added `readonly maxConcurrentRequests: number` to `Config.limits`.

- **`src/agent-scan.ts`** — Full rewrite: new signature `checkAgentModels(files, table, configuredProviders, registry?)`. Six finding kinds: `unresolvable`/`ambiguous`/`unknown_provider` (fail), `retired`/`provider_unconfigured`/`preview_only` (info). Uses `resolveModel` + registry lookup, not deprecated `makeModelResolver`.

- **`src/doctor.ts`** — Removed `codex.models` display; removed `codexModelsPinned` parameter; added `buildRoutingTable`/`PROVIDER_IDS` imports; builds routing table once; N-provider fan-out via `Promise.all([subswitch, anthropicTLS, ...providerChecks])`; ENOENT = informational (PF-006); per-provider TLS check loop; updated finding display for all 6 kinds.

- **`src/server.ts`** — Added `existsSync` + `PROVIDER_IDS` imports; replaced static `HEALTH_BODY` with `buildHealthBody(config)` returning `{name, version, providers: [{id, configured, modelCount}]}`; added `activeRequests` counter; 503 gate after `/__subswitch/*` namespace.

- **`src/cli.ts`** — Added `json: boolean` to `CliCommand` models arm; added `--json` to `MODELS_FLAGS` and `parseArgs` options; added `modelsJson(result)` function (returns before `resolveColorEnabled` — structural FORCE_COLOR isolation); updated `models()` to call `formatModelsReport` without `routable`; updated serve banner to loop over `PROVIDER_IDS`; removed `codex.models` reference from banner; removed `codexModelsPinned` false arg from `runDoctor` call.

- **`test/unit/models.test.ts`** — Replaced all `makeModelResolver` blocks with routing-table canary tests (`buildRoutingTable` + `resolveModel`); updated `formatModelsReport` tests (removed `routable`, added provider column test); added parity test (`buildAliasRows`/`buildModelRows` invariant).

- **`test/unit/agent-scan.test.ts`** — Full rewrite with new `checkAgentModels` signature; tests for all 6 finding kinds; manual `RoutingTable` construction for ambiguous test; injectable registry for retired/preview tests.

- **`test/unit/doctor.test.ts`** — Removed `codex.models`/`codexModelsPinned` from `makeTestConfig()`; added `maxConcurrentRequests: 32` to limits; removed `codexModelsPinned` tests; updated `failingProbeIO` to use non-ENOENT error; added PF-006 tests (ENOENT = info, non-ENOENT = failure, `provider_unconfigured` = info).

- **`test/unit/config.test.ts`** — Removed `codex.models` assertions and describe block; added `limits.maxConcurrentRequests` default (32) and override tests.

- **`test/integration/cli.test.ts`** — Added `models --json` suite: A14–A22 (exit 0, valid JSON, kind/schemaVersion/models/providers/fallbackProvider/gen-as-tuple/config-alias), P5 (FORCE_COLOR negative control — no ANSI in JSON output).

### Patterns Established

- **Builder pair**: `buildAliasRows` + `buildModelRows` over shared helpers; parity test enforces that both views agree on alias names.
- **FORCE_COLOR isolation**: JSON branch returns before `resolveColorEnabled` — structural, not conditional.
- **PF-006 ENOENT**: `(e as NodeJS.ErrnoException).code === "ENOENT" || e.message.includes("ENOENT")` to handle both production and test error shapes.
- **N-provider fan-out**: `PROVIDER_IDS.map(async (id) => checkOneProvider(id))` collected into `Promise.all([fixed, ...providerChecks])`.
- **Health body**: `buildHealthBody(config)` called per-request (not static cache) to reflect live `existsSync` state.
- **503 gate**: `activeRequests` counter incremented after `/__subswitch/*` check so health never counts against the limit.

### Key Decisions

- `maxConcurrentRequests` gate placed after `/__subswitch/*` namespace so health checks are never gated. Aligns with spec: 7h says "503 on over-limit" and health must always respond.
- `gen` field omitted (not null, not `[]`) when the tuple is empty — `exactOptionalPropertyTypes` compliant via conditional spread.
- `preview`/`retired` always present as booleans on `ModelRow` — consumers write `if (m.preview)` with no `?? false`.
- `buildHealthBody` is called per health-request (not pre-built once) so `existsSync` reflects current credential state at call time.

### Zero @deprecated markers remain in src/ ✓
### npm run check: 409/409 passing ✓
