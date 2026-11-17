# Kimi route status

Explicit routes use subscription sign-ins only. The supported products are
`claude-code`, `chatgpt-codex` and `kimi-code`. Each profile uses
`native-oauth` and `billing: "subscription"`.
Provider keys, environment credentials, API billing and paid fallback are not supported.
Removed product or credential kinds fail config load with a clear error.

Kimi Code supports an explicitly selected native login or a separate managed OAuth store.
See [Kimi subscription OAuth boundaries](kimi-managed-oauth.md) for configuration,
regional endpoints, store requirements and known limits. No implicit credential fallback exists.

Claude Code is the primary client for new provider qualification.
The Codex client remains in maintenance mode. OpenAI/Codex remains an active destination for Claude Code.

## Current checks

Offline tests cover subscription credentials, renewal, lock coordination,
caller-owned tools, continuation, fallback and recovery. These tests use fabricated
private stores and owned loopback providers. They do not certify live provider behavior.
Kimi Messages output has no native Claude ownership claim. Exact same-scope
replay can continue; another scope receives HTTP 409 before provider dispatch.

A bounded manual Claude Code Agent/Read flow observed two Kimi HTTP 200 sends,
owned continuation and the exact parent answer. Its separate strict complete-child
report remains failed. General identity acceptance, live renewal and the configured
fallback/recovery flow still need live evidence. No live run is authorized here.

## Retained evidence

`kimi-offline-2026-10-19.json` records an earlier key-based offline audit.
`native-kimi-headless-live-2026-10-12.json` records direct native CLI access and a native tool read.
`wave1-evidence.json` retains earlier implementation and acceptance records.
These files describe past runs, not current subscription-route qualification.
Do not use the past key-based plan as a current run instruction.
