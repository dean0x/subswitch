# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [0.3.0] - 2026-08-20

### Fixed

- **Codex auth concurrent-refresh guard** — replaced the lexicographic string `>` comparison
  on `last_refresh` timestamps in `persistTokens` with a refresh-token identity check
  (`fileNow.tokens.refresh_token !== refreshToken`). The old comparison depended on the
  Codex CLI emitting byte-identical ISO-8601 formatting indefinitely; a format divergence
  or same-second collision could cause the guard to miss, letting subswitch clobber the
  CLI's rotated refresh token. The identity check is format-independent and is the
  established idiom already used in the `invalid_grant` retry path. A `Date.parse` numeric
  comparison is kept as a secondary signal for correct ordering when timestamp formats
  differ (e.g. `"…08:00:05.500Z"` vs `"…08:00:05Z"` sorts wrong lexicographically but
  right numerically). (Fixes #26)
- **Codex auth guard bypass on materialFrom failure** — when `fileIsNewer` is true but
  `materialFrom` fails on the newer file, the branch now serves the just-refreshed tokens
  from memory rather than returning an error. The newer file's refresh_token is still never
  clobbered (no write occurs); the request succeeds using the valid tokens we hold.
  Previously, control fell through into the merge and wrote our refresh result anyway,
  defeating the guard even when it had correctly fired.

- **Anthropic passthrough — `connectTimeoutMs` now genuinely bounds DNS resolution and
  TCP establishment** (fixes #27).
  Previously `upstream.setTimeout(connectTimeoutMs)` was called on the `ClientRequest`
  object, but Node's implementation defers that call via an internal `'connect'`
  listener — so it fired only after TCP connect, meaning `connectTimeoutMs` was never in
  force for any measurable interval.  Measured against a blackholed IP (`192.0.2.1`,
  TEST-NET-1) with `connectTimeoutMs=700`, the request previously failed after
  **75 019 ms** (the macOS kernel TCP timeout).  The fix arms the timer **directly on the
  socket** inside the `'socket'` event handler, before DNS resolves, so the budget covers
  the full connect window: DNS lookup plus TCP SYN/ACK.  The same measured scenario now
  fails at ~700 ms.  **Upgrade note:** operators with a slow DNS resolver may now see
  `connectTimeoutMs` 504s that 0.2.0 would have passed through — the budget is now
  enforced for the first time.

- **Anthropic passthrough — `x-subswitch-synthesized: 1` header marks every relay-generated response; stripped from proxied responses** (stacks on #30).
  Previously a relay fault (502 connection failure, 504 timeout, 500 internal proxy error, 413 body too large,
  431 header fields too large) was indistinguishable from an upstream outage on the client side.  Every response the
  relay synthesises itself now carries `x-subswitch-synthesized: 1`; this covers the Anthropic-leg error
  paths, all codex-leg responses (both streaming SSE and aggregated JSON — the codex leg translates
  Codex→Anthropic format so every byte it returns is relay-synthesised), and every relay-generated error in
  `server.ts`.  On the proxied path the header is actively stripped from upstream responses via the hop-by-hop
  filter so an origin that sets it cannot impersonate the relay.  Bodies and status codes are unchanged — the
  header is purely additive.  See the new `## x-subswitch-synthesized` section in the README for the
  operator-facing wire contract.

- **Anthropic passthrough — a pre-header upstream timeout no longer produces a spurious
  `anthropic_upstream_error` warn** (fixes #27).  In 0.2.0, when the Anthropic upstream
  timed out before sending response headers, the relay emitted two simultaneous warn
  events — `anthropic_upstream_timeout` and `anthropic_upstream_error` — because
  destroying the timed-out request caused a second error event that the error handler
  logged unconditionally.  In 0.3.0, at most one warn event fires per upstream request:
  whichever terminal outcome responds first claims the log slot; any subsequent error
  event is silently discarded.

- **404 responses now use the same Anthropic-shaped error body as all other synthesized
  errors.**  Previously an unknown path returned a bare 404 with no body.  The body now
  carries `{ type: "error", error: { type: "not_found_error", message: "…" } }` and the
  `x-subswitch-synthesized: 1` marker, matching every other relay-generated response.

- **Unhandled-exception route labeled `internal_error` in the `request_complete` log.**
  When an unexpected exception occurs during request handling, the `route` field in the
  `request_complete` event is now `"internal_error"` rather than whatever routing label
  was in effect when the exception fired.  This makes relay-side panics distinguishable
  from normal traffic in post-hoc log analysis.

### Changed

- **`anthropic.maxUpstreamSockets` default raised from 32 to 256.**  With no relay-side
  concurrency cap, the old pool of 32 sockets created silent `http.Agent` queuing at
  realistic peak load (~100 concurrent Claude Code sub-agents).  256 gives comfortable
  headroom over realistic peak concurrency.

- **Colon-bearing model names with unknown prefixes now forward to Anthropic** instead of
  returning a relay-invented 400.  When a model name like `claude-sonnet-9:preview`
  contains a colon whose prefix is not a registered provider, the relay logs a diagnostic
  warning and forwards to Anthropic unchanged.  Real `codex:` qualified names continue to
  route to the Codex provider as before.

- **Ambiguous model family names now forward to Anthropic** instead of returning a
  relay-invented error.  When two providers claim the same family name, the relay logs an
  `ambiguous_model_name` warn carrying the provider list and forwards the request to
  Anthropic unchanged (ADR-010: the relay has no authority to adjudicate a registry
  conflict it did not cause).

- **`doctor` `unknown_provider` finding downgraded from `fail` to `info`.** An agent
  frontmatter naming a colon-qualified model with an unknown prefix (e.g. `myco:mymodel`)
  previously produced a severity `fail` finding and caused `subswitch doctor` to exit 1.
  Because the relay now forwards those requests to Anthropic unchanged, the finding is
  informational — the agent works, just not via Codex.  `ambiguous` (two providers claim
  the same family name) remains `fail`: that conflict is relay-derived and will 404 at the
  origin regardless of which upstream handles it.

- **413 now uses error type `request_too_large`** instead of `invalid_request_error`,
  matching the Anthropic API's own error taxonomy for oversized bodies.  A 413 response
  now also drains the remaining upload bytes before closing the connection, with a 2-second
  hard cutoff; in 0.2.0 the connection closed immediately, which could prevent the client
  from reading the 413 body if its TCP write buffer was still filling.

- **`SERVER_TUNING` constants set explicitly on the HTTP server**: `requestTimeout`
  (600 s — Anthropic's own server-side ceiling for long-running requests), `headersTimeout`
  (120 s — maximum time to receive all request headers), `keepAliveTimeout` (300 s —
  matches Anthropic's idle-socket keepalive window so the relay's pool never evicts a
  socket the origin still considers live), `maxRequestsPerSocket` (unlimited, matching
  the Anthropic origin's behaviour), and `maxHeaderSize: 64 * 1024` (raises the inbound
  header ceiling from Node's 16 KiB default to 64 KiB — also determines when the relay
  fires a 431 Header Fields Too Large).  Previously these values were whatever Node's
  built-in defaults happened to be.  Inbound timeouts (`requestTimeout`,
  `headersTimeout`) that expire now return an Anthropic-shaped `408` with
  `x-subswitch-synthesized: 1`; in 0.2.0 Node emitted its own unshapeable bare `408`
  that no relay code produced or logged.

### Added

- `request_too_large` and `not_found_error` added to the internal `AnthropicErrorType` union.
- **`client_disconnected` log event** — emitted (at `info` level) when the client closes the
  connection before any response headers are sent (e.g. a cancelled upload). Fields: `path`,
  `route`, `model` (optional), `latencyMs`. `request_complete` is **not** emitted for the same
  request — the two events are mutually exclusive. This distinguishes an abandoned request from a
  served one: without this event, a vanished client would either produce no log entry or a
  misleading `request_complete status=200` (Node's default initialiser, not a real status).
- **Two new `route` values for fail-open forwards** — `anthropic:ambiguous` (two providers claim
  the same family name) and `anthropic:fallback` (colon-qualified name with an unknown prefix).
  Both carry the `anthropic` prefix so leg-level filtering continues to work; the suffix makes
  fail-open forwards distinguishable from intended Anthropic routes in `request_complete` and
  `client_disconnected` log queries.

### Changed

- **`route` field: three values retired on this branch.** Operators filtering logs on `route`
  should update their queries:
  - `"rate_limited"` — removed with the admission gate; requests are no longer rejected at the
    relay level for rate-limit reasons.
  - `"ambiguous"` — replaced by `"anthropic:ambiguous"` (fail-open forward; see above).
  - `"unknown_provider"` — replaced by `"anthropic:fallback"` (fail-open forward; see above).

### Removed (BREAKING)

- **Two config keys are now fully removed** and produce a hard error on load if present.
  Delete these keys from your `subswitch.config.json` before upgrading:
  - `anthropic.streamIdleTimeoutMs` — the relay does not bound the stream-idle phase on a
    connected client (ADR-010).
  - `limits.maxConcurrentRequests` — the admission gate was removed (ADR-010).

  If your config contains either of these, `subswitch` exits immediately with a message
  naming every offending key.

## [0.2.0] - 2026-08-09

### Upgrading from 0.1.0

**A 0.1.0 `subswitch.config.json` will not start the server.** If you copied the
example config shipped with 0.1.0, or wrote a config in the old layout, the process
exits immediately with:

```
outdated config layout in subswitch.config.json — move `codex` to `providers.codex`; move `reasoningCache` to `providers.codex.reasoningCache`; move `limits.connectTimeoutMs` to `anthropic.connectTimeoutMs`; move `limits.maxUpstreamSockets` to `anthropic.maxUpstreamSockets`; move `limits.streamIdleTimeoutMs` to `anthropic.streamIdleTimeoutMs and/or providers.codex.streamIdleTimeoutMs`; move `limits.requestTimeoutMs` to `providers.codex.requestTimeoutMs`; move `limits.maxSseEventBytes` to `providers.codex.maxSseEventBytes`; move `codex.models` to `(removed — routing now follows the built-in model registry; use providers.codex.aliases for custom names)`. Edit the file to match subswitch.config.example.json, or delete it to run on defaults.
```

> [As of 0.3.0, `anthropic.streamIdleTimeoutMs` was removed — migrate directly to
> `providers.codex.streamIdleTimeoutMs`.]

**Two ways forward:**

1. Edit `subswitch.config.json` to match the new `subswitch.config.example.json` layout
   (the migration table in the Breaking Changes section below lists every key that moved).
2. Delete `subswitch.config.json` and run on defaults — the proxy works out of the box
   once Codex auth is in place.

> **Warning — migrating the `codex` block wholesale:** The migration table's first row
> says `codex.*` moves to `providers.codex.*`. Copying the entire old `codex` block
> as-is carries the removed `codex.models` key along with it. The schema uses strict
> key checking, so `providers.codex.models` produces a second, less helpful error rather
> than the guided migration message above. Drop `models` from the block before copying.

### Breaking Changes

#### Non-default base URL hosts now refused by default

**`subswitch serve` now exits with an error** if `providers.codex.baseUrl`,
`providers.codex.oauthTokenUrl`, or `anthropic.baseUrl` points at a host other than
the provider's expected default (`chatgpt.com`, `auth.openai.com`, and
`api.anthropic.com` respectively), **unless the new opt-in key is set**.

Previously, a non-default host emitted a startup warning and the server started
anyway. A warning is easy to miss in a long `serve` session, and a hostile
`subswitch.config.json` in a cloned repository would silently forward the user's
subscription credentials and OAuth refresh token to an attacker-chosen host.

**If you were intentionally overriding a URL to route through a trusted proxy**, add
the opt-in key to your `subswitch.config.json`:

```json
{
  "providers": {
    "codex": {
      "baseUrl": "https://your-proxy.example.com/...",
      "oauthTokenUrl": "https://your-proxy.example.com/...",
      "allowInsecureBaseUrl": true
    }
  }
}
```

Or for the Anthropic leg:

```json
{
  "anthropic": {
    "baseUrl": "https://your-proxy.example.com/v1",
    "allowInsecureBaseUrl": true
  }
}
```

**Loopback addresses (`127.*`, `localhost`, `::1`) are always exempt** — the e2e
wire-recorder workflow (`http://127.0.0.1:4142`) continues to work without the opt-in.

`oauthTokenUrl` is also gated because it carries the long-lived OAuth refresh token —
more damaging to expose than the short-lived access token in `baseUrl`.

#### Config file format restructured

**This is a breaking change if you have an existing `subswitch.config.json`.** There
is no automatic migration and no compatibility shim. A compatibility shim was not
written because Zod's default behaviour strips unknown keys — a shim would have
silently reverted any custom settings the old keys held to their defaults rather than
carrying them forward, which is worse than a hard error. The change is enforced loudly
at load instead.

What moved and what was removed:

| Old key | New location |
|---------|-------------|
| `codex.*` (entire block) | `providers.codex.*` |
| `reasoningCache.*` (top-level) | `providers.codex.reasoningCache.*` |
| `limits.connectTimeoutMs` | `anthropic.connectTimeoutMs` |
| `limits.maxUpstreamSockets` | `anthropic.maxUpstreamSockets` |
| `limits.streamIdleTimeoutMs` | `anthropic.streamIdleTimeoutMs` and/or `providers.codex.streamIdleTimeoutMs` |
| `limits.requestTimeoutMs` | `providers.codex.requestTimeoutMs` |
| `limits.maxSseEventBytes` | `providers.codex.maxSseEventBytes` |
| `codex.models` | **Removed** — routing now follows the built-in model registry; use `providers.codex.aliases` for custom names |

> [As of 0.3.0, `anthropic.streamIdleTimeoutMs` was removed — migrate directly to
> `providers.codex.streamIdleTimeoutMs`.]

Two `subswitch init` flags were also removed:

| Old flag | Replacement |
|----------|-------------|
| `--codex-model <name>` | **Removed** — use `providers.codex.aliases` in config to map custom model names |
| `--codex-models <csv>` | **Removed** — use `providers.codex.aliases` in config to map custom model names |

An old config file is **rejected at load** with an error that names each key and its
replacement. This is intentional: Zod's default behaviour strips unknown keys, so
without the detection gate every custom setting would silently revert to defaults.

For the same reason, a `providers.<id>` block written under an id subswitch does not
ship — a typo like `providers.codexx`, or a provider from a future release — is also
**rejected at load**, naming the offending key and listing the known provider ids.
Such a block would otherwise be stripped by the schema and do nothing at all.

### Added

- **`providers.codex.allowInsecureBaseUrl`** (default `false`): opt-in that permits
  `providers.codex.baseUrl` or `providers.codex.oauthTokenUrl` to point at a
  non-default host. When the gate fires, the error message names the offending host,
  the config key, and this opt-in key.
- **`anthropic.allowInsecureBaseUrl`** (default `false`): same gate for the Anthropic
  passthrough leg.
- **`providers.codex.maxAggregateBytes`** (default `67108864`, 64 MiB): maximum total
  byte budget for a non-streaming Codex response. Responses that exceed this limit are
  rejected with a 502 rather than accumulating unbounded memory.
- **`codex_base_url_host_rejected`** log event (error level): emitted when the
  host-rejection gate fires for a Codex URL. Event name is a compile-time template
  literal over the `ProviderId` union — part of the log-injection barrier.
- **`anthropic_base_url_host_rejected`** log event (error level): emitted when the
  gate fires for the Anthropic leg.
- **Model family aliases**: `sol`, `terra`, and `luna` are now valid `model:` values
  in agent frontmatter. Each alias resolves to the highest-generation canonical id
  for that family (e.g. `sol` → `gpt-5.6-sol`). Resolution follows five rules in
  priority order: exact registry id, custom alias override, qualified `provider:name`,
  family (unique claimant), then unresolved (passes to Anthropic).
- **`subswitch models`**: new subcommand that prints the effective model registry and
  alias resolution table under the current config. `--json` emits a machine-readable
  document (see README §`subswitch models --json`) with an integer `schemaVersion`
  contract. `gen` is an integer tuple (`[5, 6]`) rather than a string (`"5.6"`)
  because string comparison sorts `"5.10"` before `"5.9"`. `preview` and `retired`
  are always-present booleans. Anthropic is listed with zero model rows — we
  prefix-match Claude names and cannot enumerate them; fabricating a list would be a
  lie consumers cache.
- **`providers.codex.aliases`** config key: free-form map of custom model name
  overrides. Aliases win over derived family aliases but never over exact registry ids.
  Neither key nor target may be an Anthropic model name; such a config is rejected at
  load because either side would route main-agent traffic to Codex.
- **`subswitch doctor`** per-provider diagnostics: doctor fans out to all configured
  providers, prints a per-provider ready banner on startup, and scans `.claude/agents/`
  and `~/.claude/agents/` for six finding kinds: `unresolvable`, `ambiguous`,
  `unknown_provider`, `retired`, `provider_unconfigured`, and `preview_only`.
  Anthropic-named subagents are skipped. Finding severity follows provider configuration
  — a provider the user never configured stays informational; only explicitly configured
  providers can fail the exit code.
- **`limits.maxConcurrentRequests`** (default: `32`): in-flight request ceiling. Requests
  above this limit receive an immediate 503. Protects against burst overload and makes
  resource usage predictable.
- **`providers.codex.requestTimeoutMs`**, **`providers.codex.streamIdleTimeoutMs`**,
  **`providers.codex.maxSseEventBytes`**: three per-Codex-leg timeout/size limits,
  split out from the old flat `limits.*` block.
- **`writeFrame` abort safety**: the SSE frame drain wait is now raced against the
  request abort signal, preventing a hang when the client disconnects mid-stream.
- **`/health` endpoint `providers[]`**: the health JSON now includes a `providers`
  array so monitoring scripts can check provider-level ready state without parsing
  server logs.
- **New modules**: `anthropic-wire-types.ts`, `anthropic-parse.ts`,
  `provider-transport.ts`, `provider-handler.ts`, `provider-auth.ts`,
  `provider-events.ts`, `models.ts`, `agent-scan.ts` — provider-neutral seams,
  the pure model registry, and the agent frontmatter scanner.

### Changed / Behavior

- **`codex.models` deleted**: the user-maintained model allowlist is gone. The compiled-in
  `MODEL_REGISTRY` is now the sole source of the routable set, built into a
  `RoutingTable` once at startup by `buildRoutingTable`. This is not a capability loss:
  every Codex route traces back to a model name the user wrote in agent frontmatter,
  and Codex auth is already a second gate. A `providers.codex.aliases` entry (rule 2)
  shadows a derived family alias but can never shadow an exact registry id (rule 1).
- **`subswitch init` no longer asks about model selection** and no longer writes a
  `codex.models` key to config. The routing decision belongs to the agent frontmatter.
- **`decideRoute` takes a typed `ModelResolution`** instead of a raw string. The router
  can no longer receive an unvalidated name via the deleted `?? model` fallback. The
  `Route` type is widened to four arms — `provider`, `anthropic`, `ambiguous`, and
  `unknown_provider` — handled by an exhaustive `switch` with a `never` default.
- **Log field `route`** now folds the canonical model id: `route=codex:messages:gpt-5.6-sol`.
  The closed `FIELD_KEYS` allow-list is unchanged; the model id rides inside the
  existing `route` value.
- **Per-provider ready banner**: startup now prints one line per provider with model
  count and target hostname, rather than a single Codex-only line.
- **Renames**: `codexStatusToAnthropicError` → `upstreamStatusToAnthropicError`;
  `isAnthropicModelName` → `isReservedAnthropicName`.
- **Resolved config is keyed by provider id**: the runtime `Config` now exposes
  `providers.<id>.*` instead of a top-level `codex` block, matching the on-disk shape.
  `anthropic` deliberately stays top-level — it is the privileged default leg, not a
  peer provider. Provider totality is now compile-enforced at every site (schemas,
  resolvers, accessors, alias records, handler table), replacing two comments that
  asked contributors to remember. The **on-disk format is unchanged** by this.
- **The provider handler is genuinely provider-neutral**: it receives its own config
  slice rather than the whole `Config`, takes a required `providerId` from the closed
  `ProviderId` union rather than an optional display name no caller ever set, and
  derives its log event names from that id. The Codex leg's output and log records are
  byte-identical — `codex_effort_applied` and friends are unchanged.
- **Log event tokens are sanitized** the same way field values already were (newlines
  stripped, whitespace/`=` quoted). The closed `FIELD_KEYS` allow-list is untouched;
  this is a different axis. Every event name is a compile-time string literal, so a
  config-supplied or request-supplied string cannot become an event name. All 19
  provider-scoped names — including the 7 auth events previously hardcoded as `codex_*`
  literals in `codex-auth.ts` — are derived from the `ProviderId` union via
  `providerEvents`.
- **Provider credentials are branded with the provider they belong to**: the auth seam
  is now `ProviderAuth<P>`/`ProviderCredential<P>`, and the handler's `providerId` and
  `auth` share one type parameter. Wiring one provider's credential into another
  provider's handler is a compile error at the wiring site rather than a subscription
  token sent to a third-party host. The seam carries auth headers only — protocol
  constants stay with the handler that owns the transport. Codex sends the same values,
  in the same positions.
- **The SSE parser is linear in stream length**: undelivered text is held as an array of
  segments and joined only on the chunk that completes an event, instead of being
  concatenated into one string per chunk. Frame boundaries are unchanged by construction
  and pinned by a golden captured from the previous parser — 16,269 two-way and 49,770
  three-way splits, every one asserted to reproduce the same frame sequence. 8 MiB in
  8 KiB chunks went from 570 ms to 15 ms. No correctness test can see this change in
  either direction, so `test/tools/sse-parser.bench.ts` is the artifact that guards it.
- **Family derivation has exactly one implementation**: `selectFamilyWinners` returns the
  per-provider partition and the collapsed per-family verdict in one pass, and the router
  and the display both read it. Previously each side derived "newest non-preview,
  non-retired wins" for itself.
- **`buildHeaders` outgoing header order**: credential headers (from `authHeaders`) now
  seed the outgoing object first; the six transport constants (`openai-beta`, `originator`,
  `session_id`, `accept`, `content-type`, `user-agent`) are appended after via a `put()`
  guard that silently skips any name the credential already owns, compared lowercased.
  This restores the auth-first ordering live-verified in the `b337a75` era and hedges
  against upstream fingerprinting changes. **The ordering change is precautionary — live
  tests against both the pre-fix build (transport constants first) and the post-fix build
  (credential headers first) returned HTTP 200 with identical response headers, SSE event
  sequence, and `usage`.** The substantive correctness fix — the shadowing guard — is
  listed under Fixed below.
- **Unresolvable 401 names the login command**: when a credential refresh succeeds but the
  upstream still responds 401, the client-visible error message is now suffixed with
  `` — run `codex login` ``. The command name is sourced from
  `providerConfigFor(config, "codex").loginCommand`; it is never synthesized from the
  provider id.

### Fixed

- **A Codex stream that ended with content blocks still open returned HTTP 200 with
  empty content, silently discarding text the upstream had produced.** The
  non-streaming aggregator materialises a content block only when it sees that block's
  `content_block_stop`, and the translator emitted `content_block_stop` only from
  `response.output_item.done`. Any stream that ended without a matching done event —
  `response.completed` with items still open, an item id or `output_index` that resolved
  to no block, or a mid-stream truncation, abort, or idle timeout after `message_start` —
  therefore produced a **200 whose `content` was empty**, with no error anywhere. The
  streaming path was unaffected and showed the correct text, which is why no streaming
  unit test and no streaming e2e could see it.
  The translator now reconciles blocks the upstream left open at the terminal event, and
  the same turn returns a **502 carrying an error frame** when its content cannot be
  recovered at all. Specifically:
  - Open blocks that received at least one delta are closed with a synthesised
    `content_block_stop`, emitted **in band, before `message_delta`/`message_stop`** — a
    streaming client that receives a `content_block_stop` after the terminal frame sees a
    corrupt stream. Open blocks that received zero deltas are discarded rather than
    appended as a spurious empty text block.
  - A delta that matched no block is a dropped delta. When no block received any content,
    the turn is unrecoverable and now yields an error frame instead of an empty 200; when
    other blocks did receive content, it degrades gracefully and the real content is
    returned.
  - A stream that opened but produced no recoverable content and no terminal lifecycle
    event now yields an error frame rather than a 200 with empty or null content.
  - A tool-use block whose accumulated arguments are non-empty but unparseable now returns
    502 instead of a 200 with `input: {}` — the client no longer acts on invented empty
    arguments. A genuinely empty argument string still yields `input: {}`, which is
    correct for a zero-argument call.
- **A credential that cannot be refreshed is no longer refreshed anyway**: the 401
  retry guard read `attempt === 0` while the retry budget was `refreshable ? 2 : 1`, so
  a static-credential provider spent a refresh its budget of one attempt did not allow
  and the client received a synthesised "authentication failed after refresh" instead of
  the upstream's own 401. The Codex leg sets `refreshable: true` and is unaffected — its
  request sequence and error text are unchanged.
- **Credential redaction in client-visible error messages**: `redactCredentials` is now
  applied inside `toAnthropicErrorBody` — the chokepoint both upstream-text relay paths
  funnel through (the handler's body peek and `codex-response.ts`'s SSE `response.failed`
  interpolation). Bearer tokens and JWTs are stripped before the text reaches the client.
- **Temp file writes use O_EXCL and are unlinked on failure**: `codex-auth.ts` and
  `src/init.ts` temp writes now both use `open(tmp, "wx", 0o600)` (O_EXCL) — files are
  created exclusively with `0o600` permissions and the temp is unlinked on any write
  failure, closing the predictable-temp-path and world-readable race conditions.
- **Case-variant header shadowing**: previously a credential that supplied a header name
  that matched a transport constant under a different case (e.g., `Content-Type` vs
  `content-type`) caused both to be emitted; undici comma-joins duplicate header names
  into a single malformed value. The `put()` guard compares names lowercased before
  writing, so exactly one value is emitted and the credential's version wins.

### Known limitations and deferred work

These items are deliberately deferred — they are real constraints that should be fixed
before adding a second production provider:

- **`PROVIDER_IDS[0]`-vs-declaring-provider and per-provider default-host checks are
  unfalsifiable with one provider id.** Both are correct by inspection and by an
  out-of-tree probe, but no in-suite test can distinguish them until a second id ships.
  The tests that touch these axes say so at the assertion site; do not read their green
  as coverage.
- **`e2e/capture/codex-recorder.ts` cannot capture SSE from the live backend**: its
  detection gates on `contentType.includes("text/event-stream")`, but the production
  `/responses` stream sends no `Content-Type` header at all, so the recorder silently
  degrades to pass-through mode and captures no events and no `usage`. It works correctly
  only against local fixture upstreams, which do set the header. A one-line
  `|| contentType === ""` relaxation fixes it. Anyone repeating the live-capture protocol
  with the checked-in recorder will get empty event captures and may wrongly conclude the
  stream is broken. ([#21](https://github.com/dean0x/subswitch/issues/21))
- **`e2e/README.md` parity-gaps table is derived from the wrong transport**: the
  six-row table was measured against HTTP analytics REST calls from `codex exec`, which
  routes AI inference over a WebSocket app-server transport — not the HTTP `/responses`
  endpoint that subswitch emulates. Applying any of the listed "Fix" entries would
  overwrite live-verified working header constants and break the Codex leg. The README
  flags this with a warning box next to the table.
- **No `Origin` / `Sec-Fetch-Site` check on `/v1/messages`**: a cross-origin
  `text/plain` POST from a page the user visits while the proxy is running can drive the
  proxy and consume Codex quota at the user's cost. CORS prevents the page from reading
  the response, and the server binds to loopback only, so there is no credential exposure
  or data exfiltration risk — but quota and cost abuse is possible. Pre-existing since
  0.1.0, not a regression from this release.
  ([#20](https://github.com/dean0x/subswitch/issues/20))
- **Kimi provider leg** is a separate branch, gated on a five-question live probe
  requiring a real subscription.

## [0.1.0] - 2026-07-24

### Added

- **Proxy core**: local subscription-routing proxy that splits Claude Code traffic
  by model name — requests whose `model` matches the `codex.models` list are
  translated and forwarded to the Codex backend; everything else is relayed to
  Anthropic verbatim.
- **`subswitch serve`**: starts the proxy on `127.0.0.1:4141` (configurable with
  `--port`); accepts `--verbose` / `--quiet` log-level overrides for the session.
- **`subswitch doctor`**: preflight health check that reports config, codex auth
  status, subswitch-running probe, and TLS reachability for both upstream hosts.
- **`subswitch init`**: interactive wizard (powered by `@clack/prompts`) that
  writes `subswitch.config.json` and wires `ANTHROPIC_BASE_URL` into the Claude
  Code settings file; supports `--yes` for non-interactive execution and `--dry-run`
  to preview the planned writes without touching the filesystem.
- **Codex leg**: full Anthropic Messages → OpenAI Responses translation including
  system prompts, tool calling, reasoning round-trip cache (bounded LRU), and
  effort-control forwarding (`output_config.effort` → `reasoning.effort`).
- **Codex OAuth**: reads `~/.codex/auth.json`, proactively refreshes access
  tokens, and retries once on a 401.
- **`subswitch.config.json`**: optional project-level config for port, log level,
  model list, reasoning cache limits, and upstream socket pool size.

### Changed / Behavior

- **`doctor` exits non-zero when any check fails** — exit code 0 means all
  checks passed; exit code 1 means at least one check failed. This makes
  `subswitch doctor` usable as a preflight gate in scripts and CI pipelines.
  (Note: do not invoke `doctor` bare under `set -e` in CI — in CI environments
  the live checks will always fail because the proxy is not running and codex
  auth is not configured. Use `subswitch --version` for a "binary resolves"
  smoke check instead.)
- **Strict per-command flag rejection** — a known flag passed to the wrong
  command (e.g. `doctor --verbose`) now produces a clean error and exits 1
  instead of being silently accepted or ignored.
- **`init` fails closed on non-TTY / CI** — running `subswitch init` without
  `--yes` in a non-interactive environment (no TTY, or `CI` env var set) exits 1
  immediately and writes no files. Use `--yes` to opt in to non-interactive mode
  with explicit intent. `--dry-run` is the only exception — it works in all
  contexts because it writes nothing.
- **Misapplied and unknown flags produce clean `subswitch:`-prefixed errors** —
  no stack traces; exit code 1 with a human-readable message and a pointer to
  `--help`.
