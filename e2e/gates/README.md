# Bidirectional compatibility verification

**Current implementation:** see [production parity acceptance](production-parity.md)
and the [agreed scope](parity-scope.md). The notes below retain the earlier native
contract investigations; the production gateway now passes the core live flow and
is available through `init --client codex` / `init --client both`.

## Historical gate and prototype results

The historical prototype passed the native v2 tool round trip and follow-ups
before production routing was wired. See the [live reverse results](live-reverse.md)
for WebSockets, HTTP fallback, native subscription authentication, and limitations.
The existing Claude Code → OpenAI path and opt-in
[raw Codex passthrough](../codex-passthrough.md) remain available.

The later [Pi/Hermes source comparison and implementation inventory](provider-research.md)
narrows the direct Claude 429 to a tested dependency on the native system identity
preamble. A reproducible reduction test is available with
`node --import tsx e2e/gates/claude-system-control.ts`. Its exit 0 means the rejection
was reproduced, not that reverse integration passed.

## Isolated native checks

From a source checkout with dependencies and Codex CLI 0.153.3 installed:

```sh
npm run probe:native-codex
npm run probe:native-codex -- --v1
npm run probe:native-codex -- --http
npm run probe:native-codex -- --namespace-adapter
```

Each command starts the actual SubSwitch proxy and a fabricated upstream on separate
OS-assigned loopback ports. It creates a temporary `CODEX_HOME`, working directory,
Sonnet role, model catalog, and fabricated API credential. No real Codex credential
is read and no model provider is contacted. Fixture metadata selects v1 or v2
natively; no real session or feature setting is downgraded.

Codex spawns a `claude-sonnet-5` child, executes a fixed `printf` through its native
code tool, returns the tool result, and delivers the child answer to its parent.
V2 also exercises `followup_task` and the second child reply. This tests client
orchestration and raw transport, **not Claude inference or reverse translation**.
Normal runs retain WebSockets, warmup, connection reuse, and `previous_response_id`.
`--http` makes the fake upstream reject the upgrade to test native HTTP fallback;
it does not disable WebSockets in client configuration. Native HTTP requests in this
run were not compressed.

The namespace-adapter variant tests the ordinary upstream namespace and restored
native call names/markers, after an unchanged native control. Both pass on the
installed Codex 0.153.4. The runner now derives the model-cache version from the
installed client, avoiding stale test catalogs after native updates. This remains
an experimental source-only adapter, not a reverse provider implementation.

For the separate live native Claude control:

```sh
npm run probe:native-claude
npm run probe:native-claude -- --openai
```

This passes the user's existing subscription token to the unmodified native CLI
through its supported token environment variable. A temporary Claude configuration,
working directory, and separate SubSwitch proxy isolate the run. A Sonnet parent
delegates to a Sonnet role whose only tool is `Read`. The child reads an unpredictable
value from a temporary file and returns it through a real tool-result continuation.
Only `Agent` and `Read` are enabled. Hooks, inherited settings, slash commands, and
MCP configuration are excluded; managed policies still apply. Credentials are not
written into project files or shared stores, and no new login is performed.

`--openai` assigns the native Claude child to `sol` (currently `gpt-6.2-sol`).
This tests the existing Claude Code → OpenAI translator. It reads the existing Codex access token
into a restricted temporary auth file outside the working directory, omits the
real refresh token, and disables refresh against a local endpoint. Shared Codex
credentials cannot be rotated by this test. Both providers use explicitly selected
subscription authentication. The child must perform Read and complete a tool-result
continuation through the translating handler.

The runners close stdin, bound runtime/output, and own their process groups.
Timeouts remain failures even if a wrapper exits zero after SIGTERM. Cleanup targets
only that run's processes and files. Reports contain allowlisted counts, statuses,
and booleans; they never emit native stdout/stderr, tool output, prompts, credentials,
signatures, or raw metadata.

## Direct backend checks

```sh
npm run probe:compat -- --provider openai --model gpt-6-astra
npm run probe:compat -- --provider openai --model gpt-6-astra --contract native-history
npm run probe:compat -- --provider openai --model gpt-6-astra --contract native-arguments
npm run probe:compat -- --provider openai --model gpt-6-astra --contract schema-fields
npm run probe:compat -- --provider openai --model gpt-6-astra --contract namespace-control
npm run probe:compat -- --provider claude --model claude-sonnet-5
```

The default OpenAI sequence tests the unchanged schema, the proposed three
`message.encrypted=false` changes, readable generated arguments, and plaintext
history. Failed prerequisites stop that sequence. `native-history` independently
tests known-plaintext replay with unchanged schemas. `native-arguments` asks the
unchanged schema to spawn a Sonnet child with a fixed readable task. Both independent
checks include the native positive control. Direct probes execute no agents or tools;
all messages and histories are fabricated.

`schema-fields` compares each annotation independently, false and omitted, after
one positive control (at most seven requests). `namespace-control` tests an ordinary
SubSwitch namespace, readable generated arguments, and replay (at most four requests).
These diagnostics do not enable production rewrites. Auth, network, and availability
failures stop each sequence without fallback.

Subscription is the default. OpenAI reads `$CODEX_HOME/auth.json` (default
`~/.codex/auth.json`). Claude reads its native macOS Keychain service, or
`$CLAUDE_CONFIG_DIR/.credentials.json` on other platforms (default
`~/.claude/.credentials.json`). An explicit Claude config directory selects a
separate Keychain service. Only the default macOS store was exercised live. Store
errors and expired tokens stop the check without credential refresh or fallback.

API mode is a separately selected test, never a fallback:

```sh
npm run probe:compat -- --provider openai --auth api --model gpt-6-astra --key-env OPENAI_API_KEY
npm run probe:compat -- --provider claude --auth api --model claude-sonnet-5 --key-env ANTHROPIC_API_KEY
```

An available environment variable never selects API mode. Requests use official
endpoints, reject redirects, and have development bounds of 30 seconds and 1 MiB.
There are no retries, alternate models, billing fallback, or native configuration
changes. The final stdout line is a versioned, redacted JSON report. Exit 0 means
selected checks passed; 1 means a contract or argument failed; 2 means credentials,
transport, or an upstream rejection blocked the check. HTTP 429 alone does not
diagnose subscription exhaustion.

## Observed results — 2026-09-06, Asia/Jerusalem

Environment: Node 22.22.3, Codex CLI 0.153.3, Claude Code 2.1.261, macOS.

| Check | Result |
| --- | --- |
| Native Codex v2, fabricated upstream | Pass: child model routing, native tool execution/result, parent delivery, follow-up; 2 WebSocket connections and 8 continuations |
| Native Codex v1, fabricated upstream | Pass: configured Sonnet role, native tool execution/result, parent delivery over WebSockets |
| Native Codex v2 HTTP fallback | Pass: child/tool/follow-up flow; 8 HTTP requests |
| Native Claude Sonnet parent → Sonnet child → Read → parent | Pass through SubSwitch: 5 Messages requests, tool-result continuation and final value |
| Existing Claude Code → OpenAI child → Read → parent | Pass live: 2 translated requests; also passed concurrently with the isolated Codex v2 runner |
| OpenAI subscription, unchanged native v2 schema | HTTP 200, completed response |
| Same request with three message encryption annotations set false | HTTP 400, reserved `collaboration.followup_task` schema rejected |
| Each annotation separately false or omitted | All six requests return HTTP 400, naming the changed reserved function |
| Ordinary `subswitch_collaboration` namespace | HTTP 200 for schema, exact readable Sonnet task generation, and replayed history |
| Experimental namespace adapter, native Codex 0.153.4, fake upstream | Native v2 child, tool, parent, and follow-up pass over WebSockets and HTTP fallback, each after an unchanged control |
| Corrected native plaintext history, unchanged schema | HTTP 200, completed response |
| Unchanged schema explicitly spawning a Sonnet child | HTTP 200, requested child model selected; expected readable task absent, opaque 140-character task returned |
| Direct Claude subscription forced tool request | HTTP 429, generic `rate_limit_error`, no `Retry-After`; continuation not reached |
| Direct Claude controls | Same rejection with HTTPS and fetch, streaming and non-streaming, beta query endpoint, plain text without tools, and adaptive thinking with automatic tool choice |
| Explicit OpenAI API authentication | HTTP 401 at native-schema control; later stages not reached |
| Claude API authentication | Not run: no API credential available |

Native Claude succeeds, so the earlier capacity diagnosis is withdrawn. The direct
429 identifies neither exhaustion nor credential-use enforcement. No inspected
rate-limit reset guidance or explicit `enforced_spend_limit_reached` detail was
returned. The probe distinguishes an explicit spend-limit detail from a generic
rejection. [Anthropic rate-limit reference](https://platform.claude.com/docs/en/api/rate-limits)

## Corrected wire contract

The earlier probe incorrectly inferred protocol markers from binary strings.
`[plaintext arguments]` and `[plaintext]` are **log-redaction labels**, not wire
values. Native Codex identifies readable collaboration arguments with
`encrypted_function_args: []`. Plaintext `agent_message` content is an array of
`{type: "input_text", text: ...}` blocks, and its ID begins with `amsg`.

The installed client and real OpenAI history endpoint now validate these shapes.
See the public source for [tool-call classification](https://github.com/openai/codex/blob/f5a71ff40a713eff0bb3feeb22e2ca0e1c208a08/codex-rs/core/src/tools/router.rs)
and [agent-message representation](https://github.com/openai/codex/blob/f5a71ff40a713eff0bb3feeb22e2ca0e1c208a08/codex-rs/protocol/src/models.rs).
No generated ciphertext is relabeled or decrypted.

The probe also consumes completed output items when a Responses-lite terminal
event leaves `output` empty. It still requires a valid terminal event and rejects
missing or duplicated item indices. A completed tool item or EOF alone is insufficient.

The [collaboration fixture](../../test/fixtures/native/codex-0.153.3-collaboration.json)
retains the full native namespace. The [model fixture](../../test/fixtures/native/codex-0.153.3-model.json)
contains public metadata and fabricated instructions. Labelling a fake Sonnet model
with this fixture is not a claim about Claude's real capabilities or context limits.

## Current parity boundary

The production path is covered in [production acceptance](production-parity.md).
The reserved-schema diagnostic remains a negative control; production uses the
reversible namespace adapter. Native identity compatibility is documented and
included in the user-approved parity scope.

Durable restart/resume, translated compaction, setup undo, explicit API modes for
translated inference, and broader content/tool extensions are shared follow-ups
[#45–#48](https://github.com/dean0x/subswitch/issues/45). These are not release claims.
The upstream report drafts remain unsent. Source-only runners and fixtures are
excluded from the installed package.

### Native runner entrypoints

`npm run probe:native-reverse` runs the experimental reverse harness in `native-reverse.ts`.
`npm run probe:native-production` runs `native-production.ts`, the production gateway
acceptance runner. These are live, credential-using gates and are separate from `npm test`.

## Together live check (paid)

`npm run probe:together` runs `together.ts`. It sends real paid requests to Together, so
only the founder runs it. `npm test` and CI do not run it: the test glob holds only
`test/unit` and `test/integration`, and the probe refuses to start when `CI` is set.

```sh
SUBSWITCH_TOGETHER_PROBE_ACK_USD=2.50 npm run probe:together
```

The probe loads the key through the product loader: `TOGETHER_API_KEY`, or the macOS
Keychain item "Subswitch Together API key" (account `subswitch`). It never takes the key
from argv and never prints it. Claude Code must be signed in, because the Part 1 parent
uses the subscription. The Claude Code child gets no form of the `TOGETHER_API_KEY` name.

Controls, in this order:

1. Refuse when `CI` is not empty.
2. Refuse when `SUBSWITCH_TOGETHER_PROBE_ACK_USD` is missing, does not match
   `^\d+(\.\d{1,2})?$`, or is not above 0. The value is the spend ceiling in USD.
3. Compute the worst case and refuse when it is above the ceiling. Then print the plan
   line: the paid request count, the bounds and the worst case in USD.
4. Load the key.
5. Part 0 (free): read `GET /v1/models` once. Compute the worst case again at
   max(catalog price, live price), and refuse above the ceiling before any paid request.
   A row with no numeric live price uses its catalog price. The report shows that row
   with `live: null`.

The probe writes its own `SUBSWITCH_CONFIG` temp file (mode 0600). The file sets the
Together base URL to the relay and `outputCap` to 4096. The probe sends one request at a
time and removes its temp folder at the end.

A loopback counting relay on 127.0.0.1 is the only path to Together. It forwards only the
`authorization`, `content-type`, `accept` and `user-agent` headers, with no retry and no
redirect. It refuses each of these with a local 400, which Claude Code does not retry:

- a paid request above the cap of its part (request 19 of 18 gets a refusal);
- a body above the bound of its part. The relay reads and drops a body above 1 MiB up to
  32 MiB, then sends the 400 and closes the connection. Above 32 MiB, it closes the
  connection with no reply;
- a `max_tokens` value above the bound of its part, or no `max_tokens`;
- a model that is not one of the six catalog rows;
- an `n` value other than 1 (`choices`);
- a top-level body field that the proxy translator and the Part 3 direct body do not
  build (`body_field`). An `n` field of 1 is one of these;
- an image or other content part that is not text, in Part 1 or Part 2, and more than
  one in a Part 3 request;
- in Part 1, a tool result above 4 KiB (`tool_result_bound`), or a tool result that does
  not hold the exact fixture value of this run (`tool_result_marker`). The value is
  `together-read-<uuid>`, with a new UUID for each run;
- any other route, and a second model list.

The report shows the code of each refusal in the `refused` field of its relay record. In
Part 1, `--allowedTools` allows Read only for the absolute fixture path:
`Read(//<temp folder>/work/check.txt)`.

Not established: whether Claude Code applies the path-scoped Read rule to a sub-agent.
The relay check on Part 1 tool results holds in any case: each tool result must be at most
4 KiB and hold the exact fixture value of this run. No file holds that value before the
run, because the probe makes a new UUID for each run.

| Part | Requests | Body bound | max_tokens | Checks |
|---|---|---|---|---|
| 1 | 4 | first 128 KiB, later first + 64 KiB | 4,096 | Claude Code parent with a Read-only `together:moonshotai/Kimi-K3.1-Pro` sub-agent: tool call, tool result, continuation and stream |
| 2 | 8 | 16 KiB | 2,048 | Kimi non-stream reply, mid-stream cancel, fabricated-key 401 and two-turn text replay; GLM-5.3 at max_tokens 16 (reasoning that fills max_tokens); DeepSeek V4 Pro forced zero-argument tool call and its continuation |
| 3 | 6 | 8 KiB | 16 | One 8x8 PNG for each row. The two rows without image support go straight to the relay with a probe-built body |

The worst case counts body bytes as input tokens and an image as at most 4,096 tokens. It
uses the highest row price (Kimi K3.1 Pro: 2.00 USD in and 10.00 USD out for each 1M tokens):

- Part 1: 4 × (196,608 × 2 + 4,096 × 10) / 1e6 = 1.736704
- Part 2: 8 × (16,384 × 2 + 2,048 × 10) / 1e6 = 0.425984
- Part 3: 6 × ((8,192 + 4,096) × 2 + 16 × 10) / 1e6 = 0.148416
- Total: 2.311104 USD. Set the ceiling to 2.32 or more.

The first output line is the plan. The last line is the report, or a refusal
`{"success":false,"code":"<code>"}`. The report holds statuses, stop reasons, token counts,
the replay field names, the raw tool `arguments` values and `finish_reason` values, the
catalog and live price of each row, and the image status of each row. It holds no model
text. The probe searches the report for the exact key before it prints it. On a match it
prints only `{"success":false,"code":"key_in_report"}`.

Exit codes: 0 when Part 1 passed with no relay refusal, 1 when a check failed, and 2 when a
control refused or the run stopped.
