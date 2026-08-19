# Handoff: wave/passthrough-hardening Phase 1

**Commit:** 0a00a42  
**Branch:** wave/passthrough-hardening  
**Date:** 2026-08-19  
**Task ID:** wave/passthrough-hardening  
**Tests:** 630/630 green (was 639; 9 gate tests deleted and replaced by fewer, sharper tests)

---

## What Was Done

### Items 1-5, 11, 12 + example config cleanup

---

## Files Created / Modified

### `src/logger.ts`
- **Removed** `inFlightBytes` and `reservationBytes` from `LogFields` (gate accounting fields, gate is gone)
- **Added** `as const satisfies readonly (keyof LogFields)[]` to `FIELD_KEYS`
- **Added** `_FieldKeysComplete` compile-time exhaustiveness check — adding a field to `LogFields` without adding it to `FIELD_KEYS` is now a compile error

### `src/config.ts`
- **Added** `DeprecatedConfigKey` interface and `DEPRECATED_KEYS` table (6 entries)
- **Added** `detectDeprecatedConfigKeys()` — pure, prototype-safe, reuses `hasOwnPath` helper
- **Updated** `LoadConfigResult` to add `deprecatedKeys: readonly DeprecatedConfigKey[]`
- **Made optional** in `AnthropicSchema`: `headerTimeoutMs`, `streamIdleTimeoutMs`
- **Made optional** in `LimitsSchema`: `maxConcurrentRequests`, `maxInFlightBytes`, `maxQueueDepth`, `maxQueueWaitMs`
- **Removed** `headerTimeoutMs` and `streamIdleTimeoutMs` from `Config.anthropic`
- **Removed** gate fields from `Config.limits` (only `maxBodyBytes` and `pingIntervalMs` remain)
- **Updated** `resolveConfig` to build anthropic and limits field-by-field (not spread)
- **Fixed** `LEGACY_KEY_MOVES`: `limits.streamIdleTimeoutMs` now points to `providers.codex.streamIdleTimeoutMs` only (not the now-deprecated `anthropic.streamIdleTimeoutMs`)
- **Updated** `loadConfig` to call `detectDeprecatedConfigKeys` and include result in `LoadConfigResult`

### `src/anthropic-passthrough.ts`
- **Removed** `headerTimeoutMs` and `streamIdleTimeoutMs` from `PassthroughOptions`
- **Simplified** socket handler: arm `connectTimeoutMs` only while `socket.connecting`, disarm entirely on `'connect'` — no re-arm, no further timers (ADR-010)
- **Removed** `upstream.setTimeout(options.streamIdleTimeoutMs)` from response callback
- **Replaced** bare `let settled = false` with one-way latch `settle()` function that returns `true` on first call, `false` on subsequent calls
- **Updated** all 4 terminal handlers to use `settle()`:
  - Terminal 1 (response headers): `if (!settle()) return;`
  - Terminal 2 (timeout): `if (!settle()) return;` after logging
  - Terminal 3 (upstream error): `if (!settle()) return;`
  - Terminal 4 (client close): `if (!settle()) return;`

### `src/server.ts`
- **Deleted** entire admission gate: `SlotError` type, `QueueEntry` interface, `inFlightBytes` counter, `queue` array, `drainQueue()`, `getReservationBytes()`, `acquireSlot()`, gate call site + 529 response, `releaseSlot` + finish/close accounting, chunked reconciliation block
- **Fixed** `bufferBody` memory defect: `chunks.length = 0` after `Buffer.concat(chunks)` to release the chunk array while the concatenated buffer is still in scope
- **Added** `export const SERVER_TUNING = { requestTimeout: 600_000, headersTimeout: 120_000, keepAliveTimeout: 300_000, maxRequestsPerSocket: 0, maxHeaderSize: 64 * 1024 } as const`
- **Added** `export const attachClientErrorHandler(server, logger)` — intercepts Node's `clientError` event and writes an Anthropic-shaped 400/431 response with `x-subswitch-synthesized: 1`
- **Updated** `createProxyServer`: uses `http.createServer({ maxHeaderSize: SERVER_TUNING.maxHeaderSize }, handler)`, sets all `SERVER_TUNING` fields on the server, calls `attachClientErrorHandler`
- **Updated** `buildDeps`: removed `headerTimeoutMs` and `streamIdleTimeoutMs` from `createAnthropicForwarder` call

### `src/cli.ts`
- **Changed** `serve` signature: now takes `(result: LoadConfigResult, verbose, quiet, portStr?)` instead of `(config, configPath, fileFound, ...)`
- **Added** deprecation warning loop in `serve`: after `config_loaded` log, iterates `result.deprecatedKeys`, logs `config_key_deprecated` warn and writes to stderr
- **Updated** main() call site to pass `configResult.value` directly

### `src/errors.ts`
- **Added** clarifying comment on `overloaded_error`: kept because upstream 529s pass through untouched; the relay must never synthesize this status (ADR-010)

### `subswitch.config.example.json`
- **Removed** deprecated keys: `anthropic.headerTimeoutMs`, `anthropic.streamIdleTimeoutMs`, `limits.maxInFlightBytes`, `limits.maxQueueDepth`, `limits.maxQueueWaitMs`

### `test/unit/config.test.ts`
- Removed assertions on removed fields (`anthropic.headerTimeoutMs`, `anthropic.streamIdleTimeoutMs`, `limits.maxConcurrentRequests`, `limits.maxInFlightBytes`, `limits.maxQueueDepth`, `limits.maxQueueWaitMs`)
- Replaced gate limit tests with soft-deprecation tests (keys load OK, not wired into Config, reported in `deprecatedKeys`)
- Added `DEPRECATED_KEYS` invariant test (table-driven, not hand-listing)
- Imported `DEPRECATED_KEYS` and `detectDeprecatedConfigKeys` from config.ts

### `test/unit/doctor.test.ts`
- Updated `makeTestConfig()`: removed `headerTimeoutMs`, `streamIdleTimeoutMs` from `anthropic` block; removed gate fields from `limits` block

### `test/integration/concurrency.test.ts`
- **Deleted** P0-2b through P0-2h (gate tests: queueing, single-request progress, disconnect handling, counter leak, 529 exhaustion, health, FIFO)
- **Rewrote** P0-2a: now "N concurrent POSTs all reach upstream" and "health always reachable"
- Net: 9 tests removed, 2 new sharper tests

### `test/integration/passthrough.test.ts`
- Replaced "does not 504 when think-time exceeds connectTimeoutMs but is under headerTimeoutMs" with ADR-010 version (no further timer after connect)
- Replaced "headerTimeoutMs fires..." with "slow-header upstream NOT terminated by relay" (non-vacuous: if old timer existed, 200ms upstream would 504)
- Replaced "re-arms headerTimeoutMs on pooled socket" with "pooled socket reuse succeeds when delay exceeds connectTimeoutMs"
- Replaced "streamIdleTimeoutMs fires when stream goes idle" with "idle stream NOT terminated by relay" (400ms idle gap, all 6 chunks arrive)
- Updated L3 504 test: now uses `createAnthropicForwarder` directly with `192.0.2.1:80` + `connectTimeoutMs: 150` (asserts 504 or 502)
- Removed `headerTimeoutMs: 10_000` from client abort test
- Removed `headerTimeoutMs: 80` from L3 startSubswitch call

### `test/integration/server-wiring.test.ts`
- Updated `makeMinimalConfig()`: removed `headerTimeoutMs`, `streamIdleTimeoutMs` from anthropic block; removed gate fields from limits block

---

## Patterns Established

- **Soft-deprecation via `.optional()` schema fields**: accept → parse → detect → warn. Never reject (that's for `LEGACY_KEY_MOVES`).
- **`settle()` latch**: replace bare boolean flags with a function returning `true` on first call only. All terminal handlers call it.
- **`SERVER_TUNING`** const: exported so tests can apply the same values. No magic numbers.
- **ADR-010**: connectTimeoutMs is the only timer. It is armed only while `socket.connecting` and disarmed on `'connect'`. No timer is armed on pooled sockets.

---

## Applied ADRs and Pitfalls

- **ADR-010**: relay indistinguishable from origin — no relay-invented limits on connected clients
- **PF-010**: Zod strips unknown keys — pre-parse scan is the only reliable detection
- **PF-019**: `ClientRequest.setTimeout` defers internally, cannot bound connect phase — used `socket.setTimeout` directly

---

## Integration Points for Next Phase

- `LoadConfigResult.deprecatedKeys` is populated and passed through `serve(result, ...)` — ready for use
- `SERVER_TUNING` is exported from `src/server.ts` — import it in test harnesses
- `attachClientErrorHandler` is exported from `src/server.ts` — used by `createProxyServer` already
- `DEPRECATED_KEYS` and `detectDeprecatedConfigKeys` are exported from `src/config.ts`
- `PassthroughOptions` no longer has `headerTimeoutMs` or `streamIdleTimeoutMs` — any code building options must omit them
- `Config.anthropic` no longer has `headerTimeoutMs` or `streamIdleTimeoutMs`
- `Config.limits` only has `maxBodyBytes` and `pingIntervalMs`
