# Subswitch project instructions

## Product direction

Claude Code is the primary originating client for new routing features and provider integrations. Qualify new providers for Claude Code unless Dean explicitly requests another client. New provider work does not require Codex-client feature parity.

Keep OpenAI/Codex available as a destination provider for Claude Code. This backend is separate from the Codex client integration and remains in active scope.

## Codex client maintenance mode

The existing opt-in Codex client integration is in maintenance mode. Preserve its current documented behavior and configuration compatibility. Fix security issues, regressions and shared-code defects that affect existing supported behavior.

Do not expand Codex-client features, add new-provider support for that client, or require new Codex native compatibility certification for each Claude Code feature unless Dean explicitly requests it. Keep known Codex-only limitations documented with truthful errors; do not silently alter instructions or history to hide them.

Codex-only unsupported cases do not block delivery of a Claude Code-only feature. Relevant security checks and shared regression coverage still apply. Do not remove the Codex client integration or delete Codex-named modules as part of this policy; removal is a separate decision, and some modules provide the OpenAI destination used by Claude Code.

## Quality and delivery

Resolve genuine user-visible defects on the supported Claude Code path before expanding to another provider. Distinguish product defects, failed verification predicates and behavior that has not been tested. Preserve failed results until their cause is established; do not weaken assertions merely to obtain a pass.

Validate the behavior claimed for the Claude Code route, including tool calls and results, continuation, streaming, cancellation, and any supported authentication, fallback or recovery behavior. Clearly distinguish live evidence from simulated failures and unknown capabilities. A successful build or CI run alone does not certify live provider behavior.

Keep supported-client and provider claims, acceptance gates, documentation and release notes aligned with this scope. Existing permission, credential, spending and bounded-test limits remain in force. Use the repository's established review and delivery workflow; release approval remains a separate Dean decision.

Keep this product-direction and maintenance policy consistent in the root CLAUDE.md and AGENTS.md files. Both files are repository instructions and must remain tracked in Git.
