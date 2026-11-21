# Security Policy

## Reporting a vulnerability

**Do not open a public GitHub issue for security vulnerabilities.**

Report privately via GitHub's
[private vulnerability reporting](https://github.com/dean0x/subswitch/security/advisories/new).
This routes the report to the maintainer confidentially and lets us collaborate
on a fix before disclosure.

Please include, where possible:

- A description of the issue and its impact
- The affected component (router, Codex leg, auth manager, response translator)
- Steps to reproduce
- The version (`git rev-parse HEAD`) and your platform

We aim to acknowledge reports within a few days.

## Supported versions

subswitch is pre-1.0. Security fixes are applied to the latest release only; please
update to the newest commit before reporting.

## Security model

subswitch is a **loopback-only development proxy**. It binds `127.0.0.1` and its
only clients are the developer's own tools on the same machine. It sits between
Claude Code and its upstreams — `api.anthropic.com`, the Codex backend, only for
requests that name a `together:` model the paid Together AI API, and only with a
`providers.kimi` block the Kimi coding API — all reached over TLS.

Defense-in-depth controls built into the proxy:

- **Loopback binding.** The server binds `127.0.0.1` and is never exposed to the
  network. Claude Code requires a plain-HTTP local base URL; traffic to subswitch
  never leaves the machine, and every upstream leg uses TLS. Loopback binding is not
  authentication: subswitch has no local token, so any local process can send
  requests through it, including paid Together requests (see
  [Together AI API key](#together-ai-api-key)).
- **Credentials never transit subswitch's config.** The Anthropic leg is a verbatim
  byte relay — `authorization` and every `anthropic-*` header pass through
  untouched. The Codex leg reads `~/.codex/auth.json` (written by the Codex CLI),
  refreshes the OAuth token in place, and writes it back atomically while
  preserving unknown keys. The Together key comes from `TOGETHER_API_KEY` or from
  one macOS Keychain item, never from a config file. The Kimi leg reads the sign-in
  file of the Kimi CLI and writes it back under the Kimi CLI lock (see
  [Kimi sign-in](#kimi-sign-in)).
- **Type-level redaction in logs.** Token material and request/response bodies
  are *unrepresentable* in the logger by type — the log field set is closed
  (model, path, route, status, latency, event/error codes). Nothing sensitive
  can be logged, by construction rather than by convention.
- **Bounded resources.** Request body size, SSE event size, the reasoning cache,
  and every timeout are explicitly bounded (see `subswitch.config.example.json`).
- **No telemetry.** subswitch makes no analytics or telemetry calls of its own.

## Accepted findings

Static-analysis findings that are intentional given the loopback threat model
(e.g. plain-HTTP local binding, relaying bounded upstream error detail to the
local client) are documented with rationale in [`.snyk`](.snyk).

## Bidirectional development probes

The opt-in source-checkout command `npm run probe:compat` reads only the selected
provider's credential store or named API-key environment variable. It does not
rewrite credentials, refresh tokens, change native client configuration, execute
tools, or switch billing modes. Requests use fixed fabricated messages and official
provider endpoints; redirects are rejected. Reports omit raw errors, content,
credentials, thinking, and signatures. See the [gate results and limits](e2e/gates/README.md).

The separate native-client probes create temporary configuration directories and
OS-assigned loopback listeners. `probe:native-codex` uses fabricated credentials
and local upstreams, with a fixed native `printf` tool check. `probe:native-claude`
uses the published Claude CLI, passes an existing subscription token in its token
environment variable, and enables only Agent/Read for a temporary file check.
Neither changes shared client configuration or writes a shared credential store.
Each runner owns its process group and removes its temporary files. These controls
do not certify direct third-party subscription inference.

The native Claude runner's explicit `--openai` variant checks the existing forward
translator using a temporary Codex access-token file outside its working directory.
It omits the real refresh token and sends refresh attempts only to a local rejection
endpoint, so shared Codex login state cannot be rotated. The temporary file is mode
0600 inside the run's private directory and is removed at cleanup.

## Codex ingress and Claude subscription routing

`codexIngress.enabled` enables the native Codex ingress. The separate
`codexIngress.claude.enabled` switch enables Claude model routing; both default
to false. Host/Origin checks also cover upgrades. Foreign upstreams require an
explicit opt-in, and remote destinations require TLS.

Sign-in addresses, credential file and folder keys (`providers.codex.authFile`,
`codexIngress.claude.authFile` and `codexIngress.claude.configDir`), and the
`allowInsecureBaseUrl` opt-ins load only from the user configuration or a file
selected with `SUBSWITCH_CONFIG`. A project
`subswitch.config.json` that sets one of these keys fails to load, and the error
names the key.

Native OpenAI credentials are preserved when present. Native Codex can omit the
bearer token on a local endpoint; subscription ingress then uses the existing Codex
credential manager only when the native account ID matches its configured store.
API ingress never substitutes a subscription credential. The manager is shared
with the forward translator to keep refresh single-flight across both directions.

Claude requests use only the selected Claude store: native Keychain on macOS or
the native file-backed store elsewhere, with explicit config-directory/file
overrides available. Incoming OpenAI credentials never reach Anthropic. Refresh
preserves unrelated credential fields, checks external rotation, and verifies
Keychain writes. Password data is sent to the Keychain command through stdin,
not process arguments. No credential is written into project configuration.

Reverse-enabled collaboration schemas/history are mapped through a SubSwitch
namespace. Only known-plaintext calls receive native plaintext markers. Claude
subscription requests include the native identity system preamble; this is explicit
compatibility behavior, not a client binary patch or an upstream support commitment.
Provider credential-use policies and billing classification still apply.

Claude thinking/signatures are retained in bounded process-local state referenced
by authenticated opaque handles. Replay verifies associated message/tool content.
Missing or altered state fails explicitly; durable state and translated compaction
are outside this parity change. Executable tool calls are committed only after a
valid terminal provider event. Native Codex executes the tools under its own
permissions; SubSwitch does not run an agent or tool runtime.

The production acceptance runner uses temporary access-only credential files,
real model discovery, and isolated native settings. It tests actual upstreams
without rotating shared stores. Its HTTP control rejects WebSocket upgrades and
otherwise relays bytes, exercising native fallback without changing client flags.
See [production acceptance](e2e/gates/production-parity.md).

## Together AI API key

The Together AI route is the only paid destination. Together bills each request per
token to the user's own API key. SubSwitch uses the key only for a Claude Code request
that names a `together:<model-id>` model; no other route and no fallback uses it.
Claude Code is the only supported client for this route. This section describes the
configured behavior; a live check against the Together API is not done yet.

**Local spend exposure.** SubSwitch listens on loopback and has no local token. Any
local process on the machine can send a `together:` request to the proxy, and
SubSwitch sends it to Together with the key. The `Host`/`Origin` gate stops web
pages, not local processes. Use a small prepaid Together balance with auto-recharge
off, and stop `subswitch serve` when you do not use Together.

**Spend limits.** Together has no budgets and no per-key spend caps, and Together
meters usage with a delay, so spend can overshoot a prepaid balance. SubSwitch has no
spend counter. `providers.together.outputCap` (default 16384 tokens) bounds output
tokens per request, not input tokens. The worst case is
`requests × (input tokens × input price + outputCap × output price)`. A Together 402
(balance too low) returns a 402 with `x-should-retry: false`; after a top-up, Together
can continue to return 402 for up to 5 minutes. SubSwitch makes one attempt per
request and does not retry.

**Key source and handling.**

- SubSwitch reads `TOGETHER_API_KEY` first. On macOS only, when that variable is not
  set, it reads the Keychain item with service `Subswitch Together API key` and
  account `subswitch`. It runs `/usr/bin/security` with fixed arguments, no shell, a
  10 s limit, an 8 KiB output limit and an environment that holds only `HOME`. Any
  failure means no key.
- Add the Keychain item with
  `security add-generic-password -s "Subswitch Together API key" -a subswitch -w`.
  `-w` is last with no value, so `security` prompts for the key. Never put the key
  on a command line.
- Set `TOGETHER_API_KEY` only in the environment of `subswitch serve`, not in Claude
  Code settings. `subswitch run-action` removes it from the environment of the
  native client that it starts.
- SubSwitch reads the key once, on the first Together request, and keeps it in
  process memory until the process stops. A failed Keychain read is not kept, so
  the next request tries again and macOS can ask again.
- The key goes only to the Together host, as `authorization: Bearer <key>`. Requests
  to Together carry only fixed headers; client headers and client credentials never
  reach Together. Redirects from Together are refused.
- Error bodies replace the exact loaded key value. The key is not in logs, `doctor`
  output, `models --json` or the health endpoint. `doctor` shows only the key source.
  `models` and the health endpoint never read the Keychain.
- A missing or malformed key gives a local 401 with no upstream request and no
  fallback to Anthropic. A malformed `together:` model name gives a local 400.

**Configuration trust.** The whole `providers.together` block loads only from the
user configuration or an explicit `SUBSWITCH_CONFIG` file. A project
`subswitch.config.json` that sets it, even to `{}` or `null`, fails at load, so a
workspace file cannot redirect the key or change the output cap. A workspace file can
name a `together:` model, for example in a project `.claude/agents/*.md` file or a
project Claude Code settings file. When a key is available, those requests spend the
user's Together balance and send the conversation to Together. Check a cloned repository
for such names. `subswitch doctor` lists a Together agent pin only when no usable key is
found. The startup host check accepts `https://api.together.ai/v1` by default. With
`providers.together.allowInsecureBaseUrl: true` it also accepts `api-inference.together.ai`
and `us-api.together.ai`, and no other host; `api.together.xyz` is refused. Loopback
is always accepted, for tests. A refused host stops `subswitch serve`.

**Data disclosure.** Each Together request sends the conversation to Together: the
system prompt, the messages, the tool definitions, the tool results (which can hold
file contents) and images. Together's terms and data policies apply. Together
reasoning stays in bounded process memory and is never sent to the client.

## Kimi sign-in

The Kimi route is off by default. SubSwitch reads no Kimi file and sends nothing to Kimi
unless the user configuration has a `providers.kimi` block. Claude Code is the only
supported client for this route. This section describes the configured behavior; the
tests use simulated Kimi servers, and a live check against Kimi is not done yet.

**Sign-in file.** The user signs in with `kimi login` in their own Terminal. SubSwitch
never runs the Kimi CLI and never starts a sign-in. It reads the Kimi CLI sign-in file of
the configured region. It renews the sign-in when it is due, and once after Kimi refuses
an access token. Each renewal runs under the Kimi CLI lock, has a fixed time limit, and
writes the new record back atomically with every key of the file. A renewal that may
have reached Kimi is never sent again; SubSwitch records each renewal in a small file
beside the lock before it sends it.

**File checks.** SubSwitch refuses a sign-in file or folder that is not private to the
user: the folders must have mode 0700, the file mode 0600, the user must own them, and
no link is accepted. A folder above them must not be open to writes by other users.
The file must hold a valid record of a supported Kimi CLI version (0.38.0 to 2.7.2).
Any other state gives a local 401 with a fixed text and no upstream request.

**Token handling.** The Kimi token goes only to the Kimi hosts of the region, as
`authorization: Bearer <token>`. Requests to Kimi carry only fixed headers; client
headers and client credentials never reach Kimi. Redirects from Kimi are refused. Error
bodies replace the exact loaded token value, and the token is not in logs, `doctor`
output, `models --json` or the health endpoint. From the file, `doctor` shows only the
expiry and whether a renewal is due. It also shows the configured file path, and it
never renews.

**Configuration trust.** The whole `providers.kimi` block loads only from the user
configuration or an explicit `SUBSWITCH_CONFIG` file. A project `subswitch.config.json`
that sets it fails at load, so a workspace file cannot turn the route on, change the
hosts or select another sign-in file. The region selects the hosts from a fixed table.
A host, port or file name that does not match the region fails at load, and the block
has no opt-in for other hosts. A loopback URL loads, but it stops `subswitch serve` at
startup.

**No fallback.** A Kimi failure gives a fixed local error. The request does not go to
Anthropic or to another provider.

**Local access and data.** Any local process can send Kimi requests through the proxy,
and they use the user's Kimi plan. Each Kimi request sends the conversation to Kimi,
with tool results (which can hold file contents) and images. Kimi's terms and data
policies apply. Kimi thinking stays in bounded process memory and is never sent to the
client.
