# Wave 1 implementation and gates — 2026-10-11

Explicit configuration is opt-in with `configVersion: 2`. Existing configuration is
accepted without rewriting files. Both ingresses share the explicit route dispatcher,
profile authentication, quota store and continuation ownership. Legacy routes retain
their existing provider handlers and passthrough behavior.

Use `subswitch.wave1.example.json` as a starting point. Model aliases resolve at config
load; route references and alias chains are rejected. Each target pins its effort.
Identical targets are deduplicated, with a maximum of eight unique targets. Different
profiles remain distinct. Subscription and billed API credentials are separate profiles.
The `baseUrl` override is a product root, before `/v1/responses` or `/v1/messages` (or
`/anthropic/v1/messages` for Kimi Platform), subject to HTTPS/loopback and host opt-in checks.

`sameModelApi` deliberately fails with `unverified_model_equivalence` until exact
product/region/model/capability equivalence has live evidence. The example lists K3 API
access as an explicit fallback and does not assert equivalence. Mutable coding aliases
receive no inferred equivalence. OpenAI and Claude API profiles use `openai-api` and
`anthropic-api`, API billing, and an explicitly named environment credential. API
requests carry no subscription identity headers or preamble. Kimi OAuth inference is
not enabled.

## Code structure and reliability review

The opt-in routing feature is grouped under `src/routing/`. Existing ingress modules
hand requests to `shared-routing.ts`, which owns selection and action affinity. The
HTTP adapter owns downstream writes and backpressure; `response-delivery.ts` owns
local response IDs and bounded non-streaming staging. Provider attempts own auth and
fetch lifetime, while `request-adapter.ts` owns product parameters and protocol codecs,
and `provider-stream.ts` validates incremental upstream events before releasing tools.
Authentication, quota, action, continuation and replay stores each own their state.
The CLI invocation wrapper remains in `src/run-action.ts`.

The code review added atomic replay publication, synchronous continuation/replay
budget preflight, owned half-open reservations, cancellation-listener cleanup, a bound
on pending executable tool events, terminal/tool identity validation, structural
content validation and setup-failure cleanup for the invocation wrapper. Quota byte
accounting now updates one scope rather than serializing the entire store. Regression
coverage is in the repository's flat test directories. `npm run bench:routing` compares
fixed update work at 512, 1,024, 2,048 and 4,096 scopes; `npm run bench:sse` checks the
existing incremental parser. The reviewed check run passes 1,001 tests. These checks do not establish live Kimi compatibility.
A preceding live explicit-profile run rejected an inconsistent tool terminal; the exact
field was not captured. The relay stopped that response. Two subsequent native runs
passed. This observation remains in the evidence manifest rather than being labelled
as a clean run.

## Actions and history

Run one native invocation as an action:

```sh
subswitch run-action --client claude-code --conversation my-thread -- claude --model kimi-work
subswitch run-action --client codex --conversation my-thread -- codex -m kimi-work
```

The immutable prefix includes the native tool loop and children. Separate prompts in
an interactive invocation share one action. Failover requests without an explicit
action receive `action_identity_required`. Native lifecycle certification remains
unresolved; a provider terminal event completes a response, never the action. Installed
Codex 0.162.1 needs an explicit `model_catalog_json` for foreign child model overrides.
The repaired simulated harness now passes with a Claude child name when that catalog is
configured. Automatic per-turn lifecycle certification remains pending; the production
subscription orchestration controls below do not certify Kimi routing.

Control calls require a process-local capability. `POST /__subswitch/actions` accepts
`client` and `conversationId`, and returns `id` and `ingressPrefix`. Completion closes
admission, finishing after admitted requests settle; cancellation aborts them. The
capability is private and never forwarded or logged. `serve` publishes it in an owner-only
file under `~/.cache/subswitch/actions/<port>/control.json`. The wrapper attaches to that
relay, preserving history across invocations; without a running relay it creates an isolated
relay for the invocation. Restart invalidates opaque history and response handles.
Complete portable history can start a new action. Durable resume is outside Wave 1.

Routed Responses IDs are local and expanded before upstream inference. Unknown,
foreign, lost, oversized or incompatible continuation state fails explicitly.
Thinking/signatures are target and branch owned; cross-profile opaque replay remains
disabled. The process shares a strict 64 MiB / 4,096-entry allowance across two bounded
continuation/replay partitions. Active actions and affinities have separate admission
bounds and are never evicted into new identities. Supported routed content is text and
native tools; unsupported multimodal and compaction content is rejected before inference.

## Selection and recovery

Recognized quota/rate-limit failures may advance through the ordered chain before
commitment. Overload and transport require explicit `transientTriggers`. Unknown,
auth, permission, invalid request, protocol and cancellation failures stop selection.
The stream commits on its first valid deliverable event. A later failure cannot replace
that stream. Error inspection and discarded prefixes are bounded; tool completion is
withheld until a validated terminal. No stream is aggregated to repair ordering.

Recovery uses ordinary actions with a single half-open reservation, initial 60-second
cooldown, exponential backoff capped at 15 minutes, and injected jitter. A successful
probe changes subsequent-action preference; active fallback affinities remain pinned.
Independent quota observations survive success as historical blockers with a
serviceability overlay. Reset timestamps are never manufactured from window names.

Coding-key access to cloud `/usages` is unverified, so the automatic metadata driver
stays disabled. Recovery uses normal requests. The optional metadata coordinator
supports single-flight queries with 60-second minimum spacing, 8-second timeout and
four concurrent queries. Local CLI-server usage is a separate interface. No background
inference, credit purchase, extra-usage enablement or spending-setting mutation occurs.

Discovery is `subswitch models --schema-version 3 --client all --json`. Schemas 1/2
are unchanged. Listing does not read credentials, refresh auth or query usage. Account
availability is reported as unknown. Kimi token counting reports a local estimate in
`x-subswitch-token-count: estimated`.

## Evidence and unresolved acceptance

`wave1-evidence.json` records product, region, protocol, credential kind, date, version
and evidence class. Unit fixtures are **synthetic**; Kimi documentation is not a live
pass. The repaired Codex simulated control passes HTTP and WebSocket tool execution,
child delivery, same-child follow-up and parent delivery on 0.162.1. The current live
Claude subscription control and Claude → OpenAI subscription tool control also pass
on Claude Code 2.1.296. The explicit OpenAI subscription profile also passes a real native
child read and continuation. An upload-observer regression found during these probes was
fixed and covered by the production ingress test.

`npm run probe:kimi -- --product kimi-code --region global --protocol messages`
is an opt-in basic live protocol probe. Repeat with `responses` and `--non-stream`.
`--usage` observes only the bounded cloud envelope; it does not enable a usage driver
or establish coding-key API stability. API accounts use `--product kimi-platform` and
a separate `SUBSWITCH_KIMI_PLATFORM_KEY`. Reports omit prompts, responses and secrets.
Missing credentials produce an unresolved result, not success. Current Codex production gates also pass with real OpenAI/Claude subscriptions over
WebSocket and forced HTTP fallback, including a second native read on the same child.
The HTTP gate injects WebSocket 426; the upstream inference is real. Basic protocol probes
do not certify tools, replay, native orchestration, quota exhaustion or model equivalence.

Live Kimi Code/Platform access, tool/reasoning replay, both native clients, exact K3
equivalence, usage contracts, ordinary API-profile live gates and full Wave 1
acceptance remain required. DeepSeek remains blocked on those gates.

Kimi live gates were explicitly deferred by the user in this implementation session.
