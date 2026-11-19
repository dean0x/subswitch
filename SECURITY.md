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
Claude Code and two upstreams — `api.anthropic.com` and the Codex backend — both
reached over TLS.

Defense-in-depth controls built into the proxy:

- **Loopback binding.** The server binds `127.0.0.1` and is never exposed to the
  network. Claude Code requires a plain-HTTP local base URL; traffic to subswitch
  never leaves the machine, and both upstream legs use TLS.
- **Credentials never transit subswitch's config.** The Anthropic leg is a verbatim
  byte relay — `authorization` and every `anthropic-*` header pass through
  untouched. The Codex leg reads `~/.codex/auth.json` (written by the Codex CLI),
  refreshes the OAuth token in place, and writes it back atomically while
  preserving unknown keys.
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
