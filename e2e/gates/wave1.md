# Wave 1 implementation and gates — 2026-10-11

Explicit configuration is opt-in with `configVersion: 2`. Existing configuration is
accepted without rewriting files. Both ingresses share the explicit route dispatcher,
profile authentication, quota store and continuation ownership. Legacy routes retain
their existing provider handlers and passthrough behavior.

This branch is not ready to merge: Kimi live acceptance is pending, and the current
Codex HTTP same-child follow-up control exposes unsupported instruction history.

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
existing incremental parser. The final review check passes 1,089 tests with no failures
or skipped tests; the build and both benchmarks pass. These checks do not establish
live Kimi compatibility.
A preceding live explicit-profile run rejected an inconsistent tool terminal; the exact
field was not captured. The relay stopped that response. Two subsequent native runs
passed. This observation remains in the evidence manifest rather than being labelled
as a clean run.

The second review used separate security, regression and reuse agents, followed by
integration review. It corrected account-file replacement detection, coordinated
native OAuth refresh across file aliases and legacy/profile callers, and rejected
inherited record properties while permitting explicitly configured labels. Native
credential stores now resolve the physical file before atomic writes, preserving
symlinks and private file permissions.

Continuation handles now retain their logical route and enforce client protocol,
conversation and branch ownership. Warmup expands local history without inference.
Known incompatible fallback targets are checked before authentication. Completed
tools become executable only after continuation/replay publication succeeds. Tool
terminal matching uses indexes instead of scanning all tools for each event. Metadata
reconciliation also uses a failure revision so an older request cannot clear a newer
quota failure observed in the same millisecond.

Refusal text streams incrementally and survives continuation. A late Claude refusal
maps to a **relay-synthesized** Responses incomplete terminal with `content_filter`;
this is a translation choice, not an asserted vendor semantic equivalence. Previously
delivered text is retained; output limits and valid completed tools retain their
terminal precedence. Incomplete tools remain withheld.

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

Scoped lifecycle admission also covers unmatched native HTTP and WebSocket requests.
Completion rejects new admission, drains admitted requests, then closes idle sockets;
cancellation closes active IO and stops request-bound credential waiting. Warmup and
idle sockets do not keep an invocation active. This is separate from routing affinity
and does not add response deadlines to bare native passthrough.

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

Current simulated Codex controls also pass with an unrelated explicit route and with
an action-scoped invocation over both transports. Their reports identify fabricated
upstream responses and credentials. Lazy routed/scoped WebSocket admission has a
known fallback latency cost: with an injected upstream HTTP 426, Codex 0.162.1 retries
the accepted downstream socket before switching to HTTP. The native gate observed
14 rejected upgrades and four client retry events versus two rejected upgrades and
no retry events in the unscoped, non-explicit control. All rejected upgrades precede
inference; tool execution and parent delivery still pass. Bare native passthrough
retains its original connection-phase fallback. This limitation is not a Kimi live pass.

`npm run probe:kimi -- --product kimi-code --region global --protocol messages`
is an opt-in basic live protocol probe. Repeat with `responses` and `--non-stream`.
`--usage` observes only the bounded cloud envelope; it does not enable a usage driver
or establish coding-key API stability. API accounts use `--product kimi-platform` and
a separate `SUBSWITCH_KIMI_PLATFORM_KEY`. Reports omit prompts, responses and secrets.
Missing credentials produce an unresolved result, not success. The latest Codex
production WebSocket control passes with real OpenAI/Claude subscriptions, including
a second native read on the same child. The latest forced HTTP control passes the
first child read but rejects its follow-up with `mid_history_instructions_unimplemented`.
The initial failure is retained in `native-codex-http-review-failure-2026-10-11.json`;
two bounded, sanitized diagnostic runs reproduce an unrecognized new developer
instruction after the first child answer. It does not match initial instructions or
the pinned source's factual clock markers. Arbitrary instructions remain rejected;
none were hoisted, dropped or downgraded to make the gate pass. This required native
control remains a merge blocker. Older successful runs do not replace the failed
review evidence. The HTTP gate injects WebSocket 426;
upstream inference is real. Basic protocol probes
do not certify tools, replay, native orchestration, quota exhaustion or model equivalence.

Live Kimi Code/Platform access, tool/reasoning replay, both native clients, exact K3
equivalence, usage contracts, ordinary API-profile live gates and full Wave 1
acceptance remain required. DeepSeek remains blocked on those gates.

Kimi live gates are required before merge. The user confirmed that a coding-plan key
is not available yet. Installing and logging into the Kimi CLI does not supply a
supported Subswitch credential: this implementation requires a region-matched
coding-plan key for Kimi Code; Kimi Platform uses its separate billed API key.
