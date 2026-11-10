# Managed Kimi OAuth compatibility

Subswitch adapts model-only device OAuth and refresh from MoonshotAI/kimi-code
at `67325c1b25e46b2fc66043bceab059221b719fa9` (MIT; see NOTICE). It sends honest
`subswitch/<version>` and `X-Msh-Platform: subswitch` identity. The originating
client owns instructions, history and tools; no Kimi agent is launched.

**General service identity acceptance remains unmeasured.** This is a
source-derived compatibility path, not a published official external SDK.
Pi implements native OAuth, but its approval does not transfer to Subswitch.
A separate OAuth registration requirement has not been established. OMP's full
flow remains unverified and its inspected identity headers must not be reused.
The inspected OpenClaw/Hermes built-ins use keys.

## Reuse an existing Kimi Code login

A separate Subswitch login is optional. Kimi Code 2.4.0 file credentials can be
selected explicitly:

```json
{
  "provider": "kimi", "product": "kimi-code", "region": "global",
  "billing": "subscription", "account": "personal",
  "credential": {
    "kind": "native-oauth", "source": "kimi-code",
    "authFile": "/absolute/kimi-home/credentials/kimi-code-env-0e4f99c69cc27850.json"
  }
}
```

The official default home is `~/.kimi-code`. Global uses the scoped filename
above; mainland China uses `credentials/kimi-code.json`. These names come from
the installed 2.4.0 source's fixed OAuth/API region mapping. The selected region
must match the filename and model endpoint. Custom native slots, legacy `~/.kimi`
formats and arbitrary host overrides are not supported. Subswitch never discovers
homes or reads native configuration, device identity, keychains or unrelated files.

Subswitch reads only the explicitly selected private credential file. Its directory
must be 0700 and file 0600, owned by the current user, without symlinks or hardlinks.
Concurrent replacement during a read fails closed. Before expiration, Subswitch
renews the subscription grant automatically using the fixed regional OAuth endpoint
and native-compatible `<home>/oauth/<slot>.lock` coordination. It rereads after
acquiring the lock, keeps a heartbeat, and atomically persists rotated tokens with
0600 permissions. It never starts an interactive login, changes permissions or
reads native configuration/device identity. Doctor remains read-only.

An abandoned empty lock can be reclaimed only after two stale observations,
checking ownership, inode and timestamps against an open directory descriptor.
Heartbeat or successor changes prevent reclamation. Lease loss aborts transport;
ownership is checked again after marker persistence before dispatch and after the
awaited credential guard before rename. This uses the native time-based lease
protocol. It cannot provide an atomic compare-and-swap against an uncooperative
writer; event-loop suspension and the final filesystem call retain that protocol's
small race window. Concurrent uncooperative writers remain unsupported.

A successful refresh of an unchanged locked grant preserves action lineage, so a
single 401 recovery can retry with the same caller history, instructions and tools.
A native owner's unrelated replacement has no provable login lineage and still
invalidates bound actions. Delayed 401s identify the exact dispatched bearer,
including across profile aliases. Allowance remains scoped to the selected source
across renewal and relogin; changing labels or tokens never resets quota.

A private, secret-free versioned marker distinguishes prepared (not dispatched),
pending (dispatch may have happened), denied, and retryable rejection. A prepared
intent, proven DNS/connect failure, HTTP429 or explicit OAuth client-authentication
rejection can recover on later demand/restart with persisted exponential backoff
from 30 seconds to five minutes. Lock contention is also temporary.

A lost response, malformed success, untyped HTTP503, or crash between committing
pending intent and recording a result can leave token consumption unprovable.
Those cases report `kimi_native_refresh_recovery_required`; doctor explicitly
reports recovery required. They are neither temporary failures nor proof of logout.
There is no evidenced provider idempotency/recovery contract for replaying that
grant safely. Subswitch automatically adopts an independently newer valid native
grant with normal ownership checks and stable quota. A genuinely unrecoverable
rotation can require reauthorization; routine expiry never requires manual login.
Only an explicit invalid or absent refresh grant requires reauthorization directly.
Subswitch never deletes or
revokes native credentials. It sends truthful Subswitch identity and its own
process-local UUID, never the native device identifier. General provider acceptance
and live renewal remain unmeasured; the bounded manual result below is separate.

## Optional managed login and routing

After coordinator review and authorization for a real device login:

```sh
subswitch kimi-login --auth-file /absolute/private/subswitch-kimi/auth.json --region global
```

The command displays the provider's approval URL/code without opening a browser.
The browser approval URL is supplied by the successful, schema-valid device
response. It need not share the OAuth API origin. This follows the official
[OAuth response handling](https://github.com/MoonshotAI/kimi-code/blob/990580dfe828e49f820e5d78e10fbdec4038c372/packages/oauth/src/oauth.ts#L119-L157)
and [CLI approval flow](https://github.com/MoonshotAI/kimi-code/blob/990580dfe828e49f820e5d78e10fbdec4038c372/apps/kimi-code/src/cli/sub/login-flow.ts#L40-L64).

Subswitch trusts the pinned OAuth API to choose the approval destination. This
replaces the earlier browser/API same-origin restriction; it does not add a
guessed browser hostname allowlist. Any absolute HTTPS approval destination,
including a different host or port, can be displayed after those response checks.
HTTP and other schemes, userinfo, raw spaces/control characters, backslashes and
repaired URL shorthand are rejected. Subswitch does not open or fetch the URL,
or send its credentials to it. The human chooses whether to open it for approval.
Device authorization, polling and refresh stay on the exact region-specific
HTTPS OAuth endpoints with redirects disabled. Error diagnostics contain only
fixed stage/reason values and numeric/null HTTP status, never the approval URL,
body, headers or codes. The approval URL/code appear only in the explicit
user-facing login notice.

Choose a new store in a private directory. Login refuses existing files, and never
reads/imports native Kimi state. Omitting `source` selects this managed format,
which remains separate from the native file format. The directory requires mode 0700 and files 0600,
owned by the current user. Symlinks, insecure permissions and concurrent
replacement fail closed. An abandoned lock needs operator investigation;
elapsed time alone never authorizes removing it.

Use an explicit access profile:

```json
{
  "provider": "kimi", "product": "kimi-code", "region": "global",
  "billing": "subscription", "account": "personal",
  "credential": {
    "kind": "native-oauth",
    "authFile": "/absolute/private/subswitch-kimi/auth.json"
  }
}
```

Reference it as a primary or fallback target with model `kimi-for-coding` and
effort `high`. Existing Kimi coding-plan key profiles remain supported, with no
implicit key fallback. Kimi Platform OAuth remains unsupported. The account
label groups local allowances; it does not attest provider account identity.
Token rotation preserves local login lineage; a replaced login invalidates
parked actions. Refresh uses cross-process locking and atomic revision checks.

Native OAuth model endpoints are fixed by region. Custom base URLs cannot receive
native tokens. Managed Messages uses `/v1/messages?beta=true`, Responses uses
`/v1/responses`. Exact account/model rights and both protocols still require live
qualification. Metadata, usage and model discovery are never automatic. Doctor
only reads the explicit store and reports identity acceptance as unverified.

## Ordered Messages attribution compatibility

For Messages routed to global Kimi Code subscription profiles using native OAuth,
every eligible active explicit Claude action selects `kimi-ordered-messages-v4`
from its first request. Leading system messages, top-level `system`, user-only
seeds and late system entries all use the ordered Messages-to-Responses path in
that action. This experimental subset preserves instruction and text block order,
caller tool definitions, call IDs and results; unsupported content remains refused.
Model equivalence and general live acceptance are separate gates.

The active explicit action is supplied by the existing `subswitch run-action
--client claude-code --conversation <invocation-id> -- <client> <args>` entrypoint.
The first selected request must contain no assistant history. Unscoped leading
Messages retains the native Messages path; an unscoped late-system request refuses
with `action_identity_required` before target authentication or admission.
Ordinary native Messages followed by an assistant and a later system instruction
cannot migrate into this subset. Legacy `kimi-ordered-messages-v3` associations
are not adopted by v4. A scoped fabricated seed is not evidence that normal Claude
Code generates that seed. General native segmentation and Kimi payload/encryption/
replay acceptance remain unmeasured; the existing qualification gates remain open.

Within one active action, the caller must append the exact complete published
assistant blocks. Every original control, role/block boundary and prior value
must remain identical, including metadata omitted upstream. Validated advisory
cache hints at known envelope positions may move or change; they do not form
replay identity. Fields named `cache_control` inside caller tool arguments or
schemas remain exact data. The existing process-local cache binds this prefix to
the action, agent, route, owner, credential generation and codec. Continuation
input is the exact retained dispatched input, ordered completed raw output and
new fully validated suffix. Tool execution stays with the caller. Missing,
evicted, restarted, foreign or mutated state refuses with `continuity_unavailable`;
an identical publication retry also refuses. There is no automatic retry or
durable continuity guarantee. Publication uses the existing insert-only batch
cache and atomic delivery boundary. All transient copies share one existing
32MiB pending allowance; the shared cache retains its 2048-entry/32MiB bound.

Only on that selected route, optional Anthropic `metadata` may be absent or an
object containing only optional `user_id`. An empty object is accepted. If present,
`user_id` must be a string of at most 512 Unicode code points, including the empty
string. Astral characters count once; combining code points count separately.
The renderer validates inert JSON and deliberately omits this optional abuse
attribution from the Kimi request. It does not parse, truncate or translate
the identifier, or map it to Kimi metadata labels, an identity field, instructions
or credentials. The complete original controls, including this value, participate
in the private canonical continuation identity. This is a compatibility limitation: equivalent abuse
attribution at Kimi is not established. No attribution values are logged.

Unknown metadata members, null/array metadata, nonstring or over-limit `user_id`,
and invalid JSON remain fixed-error refusals. Other unsupported request fields
remain refused. Ordinary Messages and direct
Responses routes retain their existing metadata behavior. Authentication and owner
checks keep their existing order: credential reads or refresh may precede a local
renderer refusal; its quota reservation is released without provider dispatch.

## Ordered Messages thinking compatibility

Only on the selected ordered codec above, `thinking` may be absent,
`{"type":"adaptive"}`, or `{"type":"enabled","budget_tokens":1024}`. Enabled
budgets must be finite safe integers of at least 1024, with a supplied positive
safe-integer `max_tokens`. Adaptive accepts only its `type` field.

The configured destination effort (`low`, `high`, or `max`) owns effective Kimi
reasoning and keeps it on. It overrides both caller `output_config.effort` and a
validated caller thinking budget. The numeric budget is deliberately superseded;
it is **not honored, converted to effort, or claimed equivalent**. Change the
selected destination effort to change outbound reasoning effort. `max_tokens`
still becomes the output token cap. This policy applies even when `thinking`
is absent; ordinary Messages and direct Responses behavior is unchanged.

The selected-route policy also supersedes the source-specific requirement that
the requested thinking budget be below the output cap. For example, the pinned
Claude builder can produce budget 1024 with output cap 256; this route retains
cap 256 and uses the configured categorical effort. This is an explicit mapping
policy, not validation of that envelope for a native Anthropic endpoint. The
[Anthropic budget rules](https://platform.claude.com/docs/en/build-with-claude/extended-thinking#budget-rules-and-tuning)
describe the source contract and its interleaved-thinking exception.

Disabled/off modes, display values other than exact `"omitted"` (including null),
`signature`, `block_binding`,
unknown members and invalid shapes remain fixed-error refusals. Signed, redacted
or other opaque reasoning in history remains refused, even with supported
thinking configuration; it is never discarded to make a request pass. Caller
history, instruction positions, text and tool calls/results retain their order.
Local tests establish this compatibility policy, not live model acceptance.

Exact `display:"omitted"` constrains public output to no readable reasoning.
Only that explicit setting admits the closed private reasoning-item subset:
`id`, `type:"reasoning"`, `summary`, phase `status`, and optional provisional
`encrypted_content`. Added state must be `in_progress`; a separate done snapshot
must be `completed`. The completed item may omit `encrypted_content`; if present,
it must be a nonempty string. Null, nonstring and empty completed encryption remain
refused. The completed terminal must exactly
match every done item in its original order. Every event needs a strictly
increasing safe sequence number. Summary parts begin with empty text; readable
summary deltas accumulate privately and must match text-done, part-done, item-done
and terminal snapshots exactly. Every part and item must close. The complete raw
summary and complete item, including absent encryption, remain in the existing owned continuation cache and
are replayed exactly, within the existing pending and cache allowances. They
never appear in answer text, logs or fabricated thinking/signature blocks. This
is an explicit private-retention adaptation, not Anthropic signed-thinking
equivalence. Non-omitted display, raw reasoning content parts, extra fields,
incomplete responses and missing done events refuse before public frames or
shared publication. The outgoing request includes only the internal
`reasoning.encrypted_content` selector, with `store:false`. Encryption and IDs
remain private, replayed in their original positions; they never become text or
Anthropic signatures. This deliberately narrower subset follows the
[pinned public Responses schema](https://github.com/openai/openai-node/blob/a365b5cabfea52b90c0abe808ab3123d55fb34ab/src/resources/responses/responses.ts#L7610),
whose reasoning-item encryption field is optional and whose input union accepts
reasoning items. Owned replay preserves exactly what was returned; it never
invents encryption or drops reasoning to make a continuation pass. A native test
observed the fixed missing-final-encryption guard, but Kimi continuation acceptance
for the absent-field shape remains unmeasured. At every strict
`response.created`, `response.in_progress`, `response.completed` and
`response.incomplete` envelope, own `signature`, `encrypted_content`, `thinking`,
`redacted_thinking`, `reasoning_content` and `reasoning_text` fields explicitly
refuse with `opaque_output`, even if their values are null or empty. Standard
reasoning configuration and usage metadata remain allowed. This guard inspects
only these envelope fields; it never scans or strips caller-owned tool JSON.
Ordinary Messages and direct Responses retain their existing behavior. It does
not discard reasoning to satisfy the request. This mapping does not produce Anthropic
signatures or promise signed continuation; opaque input history remains refused.
`summarized` and `updates` require different output semantics and remain refused.
A refused ordered response emits `kimi_ordered_response_refused` with a closed
`eventType` label identifying only the guard branch and lifecycle stage. The
31 labels cover six known envelope guards at four stages, reasoning events and
added reasoning items, and reasoning parts at five reconciliation stages. No
provider content, identifiers, values or raw event names enter this diagnostic.
The public refusal and atomic no-publication behavior stay unchanged; the
diagnostic status is null and does not establish an upstream HTTP outcome.
The later retired normal result identified only the `item_added_reasoning` branch;
its remaining fields and upstream HTTP outcome remain unknown. Earlier failures
retain their original unknown causes and retired retry policy.

The [pinned source SDK contract](https://github.com/anthropics/anthropic-sdk-typescript/blob/ea8d7de0e47614ae71044fbf7bf12041318ba37e/src/resources/beta/messages/messages.ts#L7265)
describes omitted display as redacted thinking with a continuity signature.

Text blocks may carry exact `citations:null` or `citations:[]`. The
[pinned text schema](https://github.com/anthropics/anthropic-sdk-typescript/blob/ea8d7de0e47614ae71044fbf7bf12041318ba37e/src/resources/beta/messages/messages.ts#L7052)
defines an optional nullable citation list. These empty forms carry no citations;
text, block boundaries and every history/tool position are preserved. Nonempty
or malformed citations remain refused. Cache hints follow the explicit portability
policy below. Tool-use `caller` ownership remains refused, even if null or empty.
Refusals use the closed `unsupported_text_block_citations`,
`unsupported_block_cache_control` (invalid cache hints) and
`unsupported_tool_use_caller` reasons.
Other unknown block keys retain `unsupported_block_field`; arbitrary names and
values never appear in those diagnostics. This does not identify the actual
block field or display value in any retired failed request.

Refusals distinguish fixed thinking type, unsupported field, display, binding,
invalid budget and invalid cap reasons. They contain no caller values or arbitrary
field names. Nonobject shapes retain the fixed top-level field/kind diagnostic.

## Ordered Messages cache-hint portability

On this selected codec, `cache_control` may be absent, null, or an exact object
`{"type":"ephemeral"}` with an optional `ttl` of `"5m"` or `"1h"`. This applies
to supported text blocks (including system text), assistant `tool_use`, user
`tool_result` outer blocks, the top-level request and function-tool definitions.
The [pinned source SDK](https://github.com/anthropics/anthropic-sdk-typescript/blob/ea8d7de0e47614ae71044fbf7bf12041318ba37e/src/resources/beta/messages/messages.ts#L2910)
defines these shapes; its nullable fields appear on
[text](https://github.com/anthropics/anthropic-sdk-typescript/blob/ea8d7de0e47614ae71044fbf7bf12041318ba37e/src/resources/beta/messages/messages.ts#L7052),
[tool use](https://github.com/anthropics/anthropic-sdk-typescript/blob/ea8d7de0e47614ae71044fbf7bf12041318ba37e/src/resources/beta/messages/messages.ts#L8246),
[tool results](https://github.com/anthropics/anthropic-sdk-typescript/blob/ea8d7de0e47614ae71044fbf7bf12041318ba37e/src/resources/beta/messages/messages.ts#L7919),
[tools](https://github.com/anthropics/anthropic-sdk-typescript/blob/ea8d7de0e47614ae71044fbf7bf12041318ba37e/src/resources/beta/messages/messages.ts#L7511)
and [requests](https://github.com/anthropics/anthropic-sdk-typescript/blob/ea8d7de0e47614ae71044fbf7bf12041318ba37e/src/resources/beta/messages/messages.ts#L9481).

These validated source hints are advisory on this route and are not forwarded or
emulated. Native Claude clients can move these markers between requests; replay
compares the validated hint-free envelope without changing caller history or
privately retained raw Responses output. Malformed hints still refuse before
lookup or dispatch. Kimi controls provider caching. Anthropic prefix breakpoints, TTL,
pricing, cache isolation and data retention have no promised equivalent here;
the [source caching contract](https://platform.claude.com/docs/en/build-with-claude/prompt-caching)
describes those provider-specific semantics. No cache hits or usage are invented.
`store:false` remains set; it does not promise zero data retention or describe
the destination's prompt-cache policy. Subswitch continuation storage and its
owner, credential generation and protocol isolation keep their existing rules.

Empty objects, unknown types or TTLs, extra members (including `scope` and
`evict_on_complete`) and invalid JSON remain refused with fixed diagnostics.
The policy preserves every prompt, text boundary, tool ID, argument, result and
history position. It does not add support for nested tool-result content,
custom/server tools, signed reasoning or unknown block fields. Same-named keys
inside caller tool arguments, schemas and result strings remain caller data.
Ordinary Messages and direct Responses retain their existing cache behavior.
Offline coverage establishes this policy, not the shape of a retired failed
request or live provider acceptance.

## Ordered Messages context preservation

The selected ordered codec accepts only an empty `context_management` object,
`{"edits":[]}`, or one exact edit
`{"edits":[{"type":"clear_thinking_20251015","keep":"all"}]}`.
The [official context-editing contract](https://platform.claude.com/docs/en/build-with-claude/context-editing#configuration-options-for-thinking-block-clearing)
defines `keep: "all"` as preserving all thinking blocks; the
[official SDK schema](https://github.com/anthropics/anthropic-sdk-typescript/blob/main/src/resources/beta/messages/messages.ts)
makes the edit list optional. The pinned caller helper constructs the exact
keep-all instruction. This codec validates those inert instructions and preserves
the full transcript as-is; it performs no context edit. Existing signed/opaque
history guards still apply, including when the caller asks to keep all thinking.

Tool clearing, compaction, limited retention, omitted keep defaults, repeated or
combined edits and extra members remain refused. Closed diagnostics distinguish
unknown context fields, invalid edit-list shape and unsupported edits without
echoing their contents. Fields with the same names inside caller tool arguments
remain data. Ordinary Messages and direct Responses retain their existing policy.
Neither static caller code nor these tests establishes the contents of a prior
live request. A fresh independently reviewed runner must recognize the new closed
codes before another qualification; existing frozen runners remain unchanged.

## Qualification boundary

Messages paths that reach the local instruction-placement check reject a
system-role entry after user or assistant history before provider dispatch.
Only that local placement refusal returns
HTTP400 `invalid_request_error` with the fixed message
`capability_rejected: mid_conv_system`. Pinned Claude Code 2.1.312 recognizes
this token and can rebuild its own request when its capability recovery callback
is available. Subswitch does not move, remove or demote instructions. Other
callers receive the same explicit unsupported-capability response and remain
fail-closed. Other continuity, opaque-state and credential-owner failures retain
their existing errors. No provider error body triggers this negotiation, and a
committed stream retains its ordinary error event rather than requesting replay.
The source contract does not prove actual client recovery or Kimi acceptance;
those remain separate validation gates.

Synthetic tests cover grants, rotation/cancellation, secure storage and caller
tool IDs/results. Every inference dispatch, including a 401 retry, invokes the relay's
injected qualification budget hook with the serialized output cap. Normal serving
has no validation budget. The managed relay uses one 30 second deadline through
headers, refresh/retry and stream consumption. Auth never performs inference.

Native-store and refresh safety tests use fabricated private files. A bounded
manual native Claude Code → Agent → Read → Subswitch → Kimi flow has verified a
successful Read, its owned continuation, two Kimi HTTP 200 responses and the exact
parent answer. The separate strict complete-child-report check remains failed for
a report-note guard and a full-text mismatch; the note's exact origin is unknown.
This does not establish general identity, account/model/protocol entitlement,
live refresh, or full native or production acceptance.

Historical isolated validation records and their stopped ledger remain preserved;
they do not authorize replay or a budget reset. Any real test needs current authority.
Report actual refusals without borrowing another client's identity. No merge or
release is authorized by this delivery.
