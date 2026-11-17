# Kimi route status

Kimi needs the subscription sign-in. This version does not provide it.
A Kimi profile fails config load with this message:

```text
Kimi needs the subscription sign-in; it is not available in this version
```

Explicit routes support Claude and Codex subscription sign-ins.
Fallback between these subscription profiles remains available.
The Kimi sign-in and its live acceptance belong to a later change.
This branch does not provide Kimi key credentials or a Kimi inference probe.

## Retained evidence

`kimi-offline-2026-10-19.json` records an earlier offline audit.
`native-kimi-headless-live-2026-10-12.json` records direct native CLI access and a native tool read.
`wave1-evidence.json` retains the earlier implementation and acceptance records.
These files describe past runs, not current route qualification.
No record certifies a Kimi destination through this version of Subswitch.
Do not use the past key-based test plan as a current run instruction.

## Retained checks

`test/unit/kimi-auth.test.ts` checks the unsupported native-auth boundary.
It also checks Claude and Codex refresh coordination when one waiter cancels.
Kimi error-envelope classifier tests remain for the later subscription integration.
They use fabricated envelopes and do not make inference calls.

No live provider or native-client acceptance run forms part of this change.
