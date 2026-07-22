# Security Policy

## Reporting a vulnerability

**Do not open a public GitHub issue for security vulnerabilities.**

Report privately via GitHub's
[private vulnerability reporting](https://github.com/dean0x/subroute/security/advisories/new).
This routes the report to the maintainer confidentially and lets us collaborate
on a fix before disclosure.

Please include, where possible:

- A description of the issue and its impact
- The affected component (router, Codex leg, auth manager, response translator)
- Steps to reproduce
- The version (`git rev-parse HEAD`) and your platform

We aim to acknowledge reports within a few days.

## Supported versions

subroute is pre-1.0. Security fixes are applied to the latest release only; please
update to the newest commit before reporting.

## Security model

subroute is a **loopback-only development proxy**. It binds `127.0.0.1` and its
only clients are the developer's own tools on the same machine. It sits between
Claude Code and two upstreams — `api.anthropic.com` and the Codex backend — both
reached over TLS.

Defense-in-depth controls built into the proxy:

- **Loopback binding.** The server binds `127.0.0.1` and is never exposed to the
  network. Claude Code requires a plain-HTTP local base URL; traffic to subroute
  never leaves the machine, and both upstream legs use TLS.
- **Credentials never transit subroute's config.** The Anthropic leg is a verbatim
  byte relay — `authorization` and every `anthropic-*` header pass through
  untouched. The Codex leg reads `~/.codex/auth.json` (written by the Codex CLI),
  refreshes the OAuth token in place, and writes it back atomically while
  preserving unknown keys.
- **Type-level redaction in logs.** Token material and request/response bodies
  are *unrepresentable* in the logger by type — the log field set is closed
  (model, path, route, status, latency, event/error codes). Nothing sensitive
  can be logged, by construction rather than by convention.
- **Bounded resources.** Request body size, SSE event size, the reasoning cache,
  and every timeout are explicitly bounded (see `subroute.config.example.json`).
- **No telemetry.** subroute makes no analytics or telemetry calls of its own.

## Accepted findings

Static-analysis findings that are intentional given the loopback threat model
(e.g. plain-HTTP local binding, relaying bounded upstream error detail to the
local client) are documented with rationale in [`.snyk`](.snyk).
