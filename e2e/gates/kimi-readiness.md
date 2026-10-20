# Kimi readiness audit and bounded acceptance plan — 2026-10-19

This lane works in the independent `subswitch-kimi` clone on
`codex/wave1-kimi-failover`, starting at
`0183d6de0edfc6229cbd54c932f76e2d136c5ffa` (PR #81). All qualification performed
here is offline. No vendor inference, native credential reads, native CLI runs,
shared proxy changes, or existing session/history changes are part of this audit.

## Authentication findings

| Path | Supported by Subswitch | Evidence |
| --- | --- | --- |
| Kimi Code, coding-plan key | Environment reference, Bearer header, explicit region | Config/auth implementation; loopback qualification |
| Kimi Platform, API key | Separate environment reference, Bearer header, API billing, explicit region | Config/auth implementation; loopback qualification |
| Kimi CLI native OAuth | CLI access was observed; Subswitch OAuth profile is unsupported | `native-kimi-headless-live-2026-10-12.json` |
| Codex or Claude native OAuth | Existing exact provider/product pairs only | Existing implementation and regression suite |

The recorded CLI pass proves headless text and a native unpredictable file read
using the configured `kimi-for-coding` alias. Its report explicitly records
`originatingThroughSubswitch: false` and `providerProtocolVerified: false`. It does
not certify K3 entitlement, Platform access, either relay protocol, or model
equivalence. This audit does not inspect the CLI's installed credential store or
convert its tokens into API keys.

The offline audit found a runtime gap behind config validation: `ProfileAuth`
could inspect an unsupported native credential path and select the Claude manager
for a programmatically supplied Kimi OAuth profile. The correction uses one exact
provider/product support predicate in config and auth. Unsupported OAuth fails
before inspecting a path or consulting a cached manager. A fabricated getter
regression failed before the correction and passes afterwards. Supported Kimi
environment-key profiles retain their existing behavior; OAuth support was not added.

Independent source review found one remaining entry point: `refresh()` could reuse
a pending supported-provider refresh after the profile was replaced with unsupported
Kimi OAuth. It now validates provider/product support before consulting that cache,
while retaining the existing rejected-promise API. Two fabricated warm-cache
regressions failed before this guard and pass with it. Supported Claude/Codex refresh
deduplication and cancellation of an individual waiter remain covered separately.

The fallback fixture uses the supported `openai-api` primary signature
`429 insufficient_quota`. It does not validate a ChatGPT subscription's live quota
envelope. The current classifier does not recognize `usage_limit_reached`; an
additional loopback regression confirms that code remains unknown and does not
activate fallback. A verified product/status/envelope fixture is needed before
extending classification; passive limit recording alone does not authorize it.

## Executable offline qualification

Run from this clone:

```sh
npm run probe:kimi:offline
```

This runs `test/unit/kimi-auth.test.ts` and
`test/integration/kimi-qualification.test.ts`. Every fixture creates a separate
HTTP upstream and Subswitch relay on OS-assigned `127.0.0.1` ports. Outbound fetches
are restricted to that fixture's upstream origin. Legacy endpoints also point to
loopback, auth-file paths point into a newly created disposable directory, and
all keys are fabricated. The HTTP clients simulate Claude Code and Codex wire
requests; no native CLI is launched. Tool execution is an explicitly implemented
fixture file read, followed by a protocol tool result and saved disposable client
state. It is not evidence of native-client orchestration.

The 27 cases cover:

- Ten auth cases: config rejection, runtime path isolation, pending-refresh rejection
  and explicit key/header binding for both Kimi products, plus supported Claude/Codex
  refresh deduplication and cancellation of one waiter.
- Eight Kimi Code/Platform × global/mainland-cn × Messages/Responses combinations:
  product path, region mapping, model/effort, key isolation and a valid terminal.
- Two real-loopback primary → fake Kimi tool/result continuations, one per client
  protocol. The fixture checks the returned tool path, reads one unpredictable
  value once, and requires fake Kimi to receive that exact result before answering.
- One injected-clock recovery flow: a subsequent action selects the recovered
  primary while an older action's tool continuation remains on Kimi.
- Three primary auth/unknown errors that must not trigger fallback, including an
  unclassified `usage_limit_reached` code with HTTP 429.
- One redirect to a second loopback origin that must not be followed.
- One committed primary quota error that must not switch providers.
- One HTTP client disconnect that must close the unfinished fake Kimi upstream.

Fixture keys, provider output and temporary client state are never persisted as
real provider evidence. Both servers/connections are closed and the fixture-owned
directory is removed on success or failure. A separate synthetic evidence record
pins the source blobs and check results.

## Dependencies before live execution

1. The coordinator must approve the exact live run and credential binding. This
   document does not execute it or authorize a new access product.
2. Bind an approved **Kimi Code/global coding-plan key** through
   `SUBSWITCH_KIMI_CODE_KEY`, in the isolated relay process only. Native Kimi CLI
   OAuth authorization cannot substitute for that binding in the current code.
   A supported native OAuth implementation would be a separate task requiring a
   verified contract; do not read/convert stored tokens to bypass this dependency.
3. Use `kimi-for-coding`, effort `high`, at
   `https://api.kimi.ai/coding`. The CLI observation makes this alias a candidate,
   not a verified API entitlement. A model/auth/protocol rejection stops the run;
   it does not select another model, region, access product or credential.
4. Wait for coordinator evidence that the separate continuity lane's
   existing-session startup/restart correction is qualified. This lane does not
   modify that clone or restart a shared proxy. Fresh-loopback qualification does
   not resolve startup/restart or the recorded Codex HTTP instruction-history gate.
5. Recheck the PR head and published/runtime versions at execution time. PR #81
   was draft at the audited head, with four successful CI jobs and no posted
   reviews. A green older head does not validate later commits.

Platform credentials, mainland endpoints, `k3`/`kimi-k3` entitlement/equivalence,
`/usages`, native OAuth refresh, and deliberate quota exhaustion are outside this
bounded live run. Broader claims require separately scoped evidence.

## Finite live plan (prepared, not executed)

### Isolation and hard limits

- Create a new fixture directory with owner-only files. Put the relay config,
  unpredictable nonce file, temporary client state and sanitized report there.
  Never copy existing native history, profiles, OAuth files or session state.
- Listen on two new `127.0.0.1:0` sockets: one relay and one fabricated primary.
  Record their assigned ports. Never use the shared proxy port or its control
  file. Explicitly bind action control to this relay, avoiding `run-action`'s
  discovery of an already running shared relay.
- The sole permitted external inference origin is `https://api.kimi.ai`, with
  product root `/coding`. The fabricated primary uses an environment key with a
  fabricated value and makes no OpenAI calls. Reject redirects and all other
  external destinations before credential-bearing dispatch.
- Permit **at most 18 Kimi inference attempts and 4,608 requested output tokens**:
  6 attempts for phase A, 6 for the Claude Code phase, and 6 for the Codex phase.
  Each request must request no more than 256 output tokens. Count every attempted
  upstream call, including rejected/error calls, before dispatch. Reject an
  over-budget request before sending it; do not silently rewrite native requests.
  Reasoning/billing semantics remain provider-defined; these are request limits,
  not a spending estimate.
- Use a 30-second deadline per vendor request, a three-minute deadline for phase
  A, and two minutes per native phase: at most seven minutes total. No automatic
  retry, quota-exhaustion load, credit purchase, account-setting change, metadata
  polling, or unplanned extra probe is allowed.
- Stop on an unexpected auth/model/protocol/history error or budget exhaustion.
  Record the failed or unexecuted stage. Do not widen the test to obtain a pass.

### Phase A: relay contracts, tool continuation and controlled fallback

For each originating protocol (Messages and Responses), use at most three live
calls, each capped at 256 output tokens:

1. Send one small text request through the isolated relay to the Kimi profile.
   Require a valid start/terminal, selected model, expected effort and a complete
   response. Record only structural/boolean evidence, not free-form output.
2. Create an explicit action and a named route with the fabricated OpenAI primary
   and Kimi fallback. Return a synthetic `429 insufficient_quota` from the fake
   primary, then ask Kimi for one read of the isolated nonce file. Require one
   valid executable tool request after terminal/replay publication.
3. Before returning the tool result, advance the **test-owned routing clock** past
   the synthetic primary cooldown and start a second action. Make the fake primary
   succeed there. Return the nonce result to the parked first action and require
   its follow-up to remain on Kimi, echo the value, and not repeat the read.

Require distinct action/route identities, the expected ordered attempts, the
correct profile credentials at the correct origin, one tool result in replay,
no upstream Subswitch continuation handles, and complete/cancel action cleanup.
Cooldown and primary recovery in this scenario are synthetic; the Kimi inference
and tool-result protocol path are live. Do not label it real Kimi quota exhaustion
or credit recovery. Preserve that distinction in the report.

### Phases B and C: native-client tool/follow-up gates

Run Claude Code and Codex separately, each with at most six Kimi calls and 1,536
requested output tokens. Reuse the existing native harnesses only after auditing
their current invocation and state isolation. Require supported per-run disposable
config/history options and explicit binding to the isolated relay/action prefix.
If isolation requires existing auth/history, permission/model overrides, or an
unsupported CLI flag, stop and report that dependency instead of running it.
If a native client cannot request an explicit output-token cap through a supported
per-run option, its phase cannot run under this budget. Report that limitation;
do not remove the cap or silently alter its requests to manufacture acceptance.

Use the named Kimi route, an isolated file-read task and a same-child follow-up.
Keep incoming client credentials as fixture-only local-proxy sentinels; the relay
alone receives the approved Kimi key. Capture installed client versions and sanitized
argument/config metadata. Require a real native tool invocation, exact nonce result,
follow-up delivery, no duplicate completed tool, and normal action closure. The
Codex phase must cover the intended transport and its instruction-history path.
The recorded HTTP follow-up failure remains a separate gate; a startup/restart fix
alone does not resolve it. A simulated client or phase-A pass cannot satisfy these
native gates. Additional transports require a separate budgeted run.

### Cleanup and evidence

On every exit, cancel or complete only the test action, stop only processes started
by this fixture, close its listener/upstream connections, and remove its disposable
directory. Clear credential references by ending the isolated child process; never
change the parent shell's environment, shared proxy, login stores or existing
session files. Persist only a sanitized report containing the exact source HEAD,
client versions, product/region/model/protocol, credential **kind/reference name**,
assigned ports, attempted-call/token counts, assertion results and cleanup outcome.
Never include key values, OAuth tokens, nonce content, private prompts or history.

A passing report certifies only the tested product, region, alias, protocol,
transport and client version. Keep unexecuted and unrelated gates pending.


## Subscription compatibility slice — offline only (2026-10-20)

`src/kimi-subscription.ts` adapts the model-only managed-auth boundary from
MoonshotAI/kimi-code commit `67325c1b25e46b2fc66043bceab059221b719fa9`.
The source notice is in `NOTICE`, included in the package. Subswitch owns updates:
review changes to upstream token fields, identity, refresh locking and provider
callbacks before changing this pin. No private monorepo package is imported.

This slice is available only through explicitly injected loopback fixtures. The
default factory rejects before reading storage or transport. Production profile
validation still rejects Kimi native OAuth; the CLI/doctor does not advertise it.
Fixtures use the true Subswitch product/version/platform, a fabricated registration
and an explicitly supplied store. They neither discover native state nor spawn an
agent. The store interface requires serialized locking and conditional publication;
these tests exercise independent manager instances over a shared in-memory store,
not OS file locks or compatibility with an actual native credential directory.

Caller history/tools are serialized unchanged. The caller executes tools and
submits their IDs/results. Refreshes are bounded separately; each model dispatch,
including one possible 401 retry, consumes the fixture's attempt/token ceiling.
Request and phase deadlines cover the response body; no other retries, device-code
polling, native tools, metadata or ancillary network operations are implemented.
These per-instance fixture counters are not a crash-persistent live allowance.

Unit controls and two loopback protocol cases qualify the adapted auth/request
boundary and existing stream validator. They do not establish relay selection,
production affinity/recovery, native OAuth codec compatibility, account attestation
or cross-process filesystem locking. Those remain integration gates.

Before production enablement, establish the legitimate Subswitch registration,
exact product/region/model/protocol endpoints, account/generation attestation and
native-store coordination. Add the production ProfileAuth/doctor wiring only after
that contract is resolved and independently reviewed. No native login, stored
credential read, provider call or new live budget is authorized by these fixtures.
The original 18-call/4,608-output-token plan remains unused and unchanged.
