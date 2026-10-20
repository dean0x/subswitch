# Managed Kimi OAuth compatibility

Subswitch adapts model-only device OAuth and refresh from MoonshotAI/kimi-code
at `67325c1b25e46b2fc66043bceab059221b719fa9` (MIT; see NOTICE). It sends honest
`subswitch/<version>` and `X-Msh-Platform: subswitch` identity. The originating
client owns instructions, history and tools; no Kimi agent is launched.

**Offline qualified; service identity acceptance is unmeasured.** This is a
source-derived compatibility path, not a published official external SDK.
Pi implements native OAuth, but its approval does not transfer to Subswitch.
A separate OAuth registration requirement has not been established. OMP's full
flow remains unverified and its inspected identity headers must not be reused.
The inspected OpenClaw/Hermes built-ins use keys.

## Explicit setup and routing

After coordinator review and authorization for a real device login:

```sh
subswitch kimi-login --auth-file /absolute/private/subswitch-kimi/auth.json --region global
```

The command displays the provider's approval URL/code without opening a browser.
Choose a new store in a private directory. Login refuses existing files, and never
reads/imports native Kimi state. The directory requires mode 0700 and files 0600,
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

## Qualification boundary

Synthetic tests cover grants, rotation/cancellation, secure storage and caller
tool IDs/results. Every inference dispatch, including a 401 retry, invokes the relay's
injected qualification budget hook with the serialized output cap. Normal serving
has no validation budget. The managed relay uses one 30 second deadline through
headers, refresh/retry and stream consumption. Auth never performs inference.

No real login, credentials or provider calls were used for this delivery. The
existing 18 attempt / 4608 requested token / 256 per attempt / 420 second ceiling is unused.
Before real calls the coordinator must review the exact head, owned HOME/XDG,
store/cache/temp isolation and transport accounting. Report actual refusals
without borrowing another client's identity. No merge or release is authorized.
