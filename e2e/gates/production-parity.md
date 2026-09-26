# Bidirectional production parity acceptance

The latest scope is the reverse counterpart of the existing forward bridge.
The implementation is now wired into `serve`, setup, model discovery/listing, and
doctor. It remains opt-in; development has not activated it in the user's real
native configuration.

## Latest usability acceptance

The [2026-09-09 usability run](usability-2026-09-09.md) exercises live native coding,
cancellation/recovery, mixed-model concurrency through one proxy, setup, failures,
and genuine Claude credential refresh. It also records the defects found and corrected.

## Live native acceptance

On Codex CLI 0.153.4 with subscription authentication and real upstream model
discovery (no seeded model cache), the production gateway passed:

| Parent | Claude child | Transport | Result |
| --- | --- | --- | --- |
| GPT-6 Astra | Sonnet 5 | WebSockets | Native tool read, result continuation, parent delivery, same-child follow-up |
| GPT-6 Astra | Opus 5 | WebSockets | Native tool read, result continuation and parent delivery |
| GPT-6 Astra | Fable 5.1 (`fable`) | WebSockets | Native tool read, result continuation and parent delivery |
| GPT-6 Astra | Sonnet 5 | Native HTTP fallback | Tool read, continuation, parent delivery and same-child follow-up |
| GPT-5.5 | Sonnet 5 | Native defaults | Configured child/tool round trip and parent delivery |

These rows were recorded when `opus` resolved to Opus 5; `opus` now resolves to
Opus 5.5, so the `opus` command below exercises Opus 5.5. The GPT-5.5 row predates
that model's retirement (Codex stops serving it on 2026-10-14); the non-v2 parent
variant below now uses `gpt-5.6-luna`, whose catalog entry is multi-agent v1.

The files contain unpredictable values absent from the prompts. Success requires
real Codex tool execution and the correct values reaching the parent. A later
Sonnet follow-up run also observed prompt-cache reads. The existing Claude Code →
OpenAI native Read/continuation test passed concurrently with reverse testing.

```sh
node --import tsx e2e/gates/native-production.ts sonnet
node --import tsx e2e/gates/native-production.ts opus --no-followup
node --import tsx e2e/gates/native-production.ts fable --no-followup
node --import tsx e2e/gates/native-production.ts sonnet --http
node --import tsx e2e/gates/native-production.ts sonnet --no-followup --parent gpt-5.6-luna
```

The runner points native Codex at the actual production gateway, uses temporary
access-only credential copies, and lets native Codex fetch its own model catalog.
The optional HTTP relay rejects upgrades, then forwards HTTP bytes to the real
OpenAI endpoint. No model requests or tool responses are fabricated in these runs.
The native Claude binary is not used by this production runner.

## Model catalog refresh — 2026-09-26

Environment: Codex CLI 0.157.1, Claude Code 2.1.283, macOS, subscription
authentication on both sides.

| Check | Result |
| --- | --- |
| Responses client → production gateway → Claude, `claude-opus-5-5` at effort `medium` and `max`, and `opus` at `low` | HTTP 200, completed stream, response model `claude-opus-5-5` |
| Same gateway, `claude-fable-5-1` or `fable` with effort `none` | HTTP 400 `reasoning_effort_unsupported_by_model`, no upstream call |
| Same gateway, `claude-opus-5-5` with `tool_choice: "required"` | HTTP 400 `tool_choice_unsupported_by_model`, no upstream call |
| Same gateway, `claude-sonnet-5-5` | HTTP 400 `unregistered_claude_model`, not forwarded to OpenAI |
| Native Claude Code parent → `gpt-6-sol` child → Read → parent (`probe:native-claude -- --openai`) | Pass: 2 translated requests, tool-result continuation, upstream 200s |
| `native-production.ts` with `opus` and with `sonnet` | Blocked: native Codex 0.157.1 fails workspace routing discovery with 401 using the runner's refresh-disabled credential copy, before any request reaches the gateway |

The Responses client in the first rows is a direct HTTP client, not native Codex, so
those rows establish translation and subscription authentication for Opus 5.5, not
native sub-agent orchestration. A direct Messages request with a forced tool choice
confirmed that the Opus 5.5 upstream rejects `tool` and `any` tool choice, which is
what the `tool_choice_unsupported_by_model` refusal anticipates.

## Important corrections from prototype to production

- Native Codex omits the bearer token on the local subscription endpoint while
  retaining the account header. Production uses the existing Codex credential
  manager with an exact account match, preserving explicit credentials and billing
  mode. HTTP and upgrade authentication retries remain bounded.
- Native HTTP replay normalizes message content and can record streaming output
  before opaque state is complete. The gateway issues an authenticated state handle
  before text and commits its contents only after validated provider completion.
  Semantic history matching tolerates serialization changes, not changed content.
- Tool calls are not executable before the terminal provider event. Text streams
  incrementally, and errors, output limits, cancellation, backpressure and usage
  accounting are represented in the native protocol.
- An upstream upgrade rejection is relayed once; closing its upstream cannot attach
  another HTTP response to the same socket.

## Parity boundary and follow-ups

The [scope matrix](parity-scope.md) is authoritative. Included: per-model routing,
aliases, subscription authentication/refresh, native tool ownership, stream and
non-stream responses, prompt caching, process-local state, setup, discovery,
diagnostics and protected passthrough.

Deferred for both directions:

- [#45](https://github.com/dean0x/subswitch/issues/45): durable restart/resume and translated compaction.
- [#46](https://github.com/dean0x/subswitch/issues/46): conflict-safe setup undo.
- [#47](https://github.com/dean0x/subswitch/issues/47): explicit API authentication for translated inference.
- [#48](https://github.com/dean0x/subswitch/issues/48): broader content, hosted tools, structured output and cross-provider history capabilities.

Native source-provider compaction remains passthrough. Translated compaction,
foreign opaque checkpoints, unsupported instruction placement and unsupported
tool/content forms receive explicit errors. API-key inference against Claude is
not silently substituted for subscription authentication.

The native identity preamble is documented in README and SECURITY. Technical
acceptance does not establish a provider support commitment or confirm which
subscription/extra-usage quota was charged.

## Automated and packaging verification

Typechecking and all **852 tests** passed after the usability fixes. The installed-tarball smoke check
validated both the unchanged forward setup and the new `init --client both`,
`models --client codex --json`, and reverse-enabled server health. The existing
SSE benchmark passed all three stream shapes within its unchanged linearity bound.
