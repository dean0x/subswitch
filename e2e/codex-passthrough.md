# Native Codex passthrough foundation

For the completed opt-in reverse feature, see [production parity](gates/production-parity.md).
The original transport-only notes below describe the raw mode with Claude routing disabled.
Native subscription requests that omit their bearer header now use a matching configured
Codex credential store; API mode does not substitute subscription credentials.

Codex-facing transport is enabled by `codexIngress.enabled`, which defaults to
**false**. This example keeps `codexIngress.claude.enabled` false and therefore
selects raw transport. `init --client codex` enables the separate Claude routing path.

For a local transport test, add the following to the SubSwitch user configuration or
to a file that you select with `SUBSWITCH_CONFIG`. A project `subswitch.config.json`
can not set the base URL keys:

```json
{
  "codexIngress": {
    "enabled": true,
    "subscriptionBaseUrl": "https://chatgpt.com/backend-api/codex",
    "apiBaseUrl": "https://api.openai.com/v1"
  }
}
```

Then start `subswitch serve`. The ready banner and health response identify this
as OpenAI passthrough with Claude translation unavailable. Native client settings
are left unchanged; start the proxy explicitly before pointing a test client at it.

| Local base path | Configured upstream | Credential source |
| --- | --- | --- |
| `/codex/backend-api/codex` | `subscriptionBaseUrl` | Original native request |
| `/codex/v1` | `apiBaseUrl` | Original native request |

The path chooses the endpoint and authentication mode. Supplied credentials are
preserved. Subscription requests that omit their bearer token can use the matching
configured Codex store. The proxy never switches endpoint or billing mode after a failure. All models, including unknown and Claude-looking names, pass
through to the selected OpenAI endpoint unchanged. No Claude model is advertised.

This foundation provides:

- HTTP streaming and non-streaming byte relay, preserving paths, queries, body
  whitespace, compressed bytes, upstream statuses, error bodies and `Retry-After`.
- A raw WebSocket tunnel preserving handshake headers and frame bytes, including
  bytes received during the upgrade handshake and multiple messages on one connection.
- Unmodified model discovery and compaction passthrough.
- Namespace isolation: unknown `/codex/*` paths return a local Responses-shaped
  404; disabled known paths return 503. Neither reaches Anthropic.
- Loopback Host/Origin protection for HTTP and WebSocket ingress, trusted-upstream
  validation, cancellation and shutdown cleanup, backpressure, and connect-only
  timeouts. Established streams have no new proxy deadline.

Standard hop-by-hop headers, including fields named by `Connection`, are stripped.
The synthesized-response marker is reserved for local errors. Native request
headers and duplicate end-to-end response headers otherwise retain their values.
HTTP errors on a rejected WebSocket upgrade retain upstream status and body.
Redirects are relayed to the client; the proxy does not follow them with credentials.

`allowInsecureBaseUrl` must be explicitly true for non-default remote hosts or
ports. HTTPS is required for remote destinations even with that option. Loopback
HTTP is allowed for local fake upstreams. URLs containing embedded credentials,
queries, or fragments are rejected. Configuration does not contain API keys.

The new ingress does not inspect or decompress request bodies. Even malformed
JSON and unknown content encodings remain the upstream's responsibility. Separate
encoded/decoded translation bounds, model-based WebSocket dispatch, continuation
state, plaintext compatibility, and Claude adapters belong to the gated reverse
implementation. They are not supplied by this transport slice.

The integration tests use fake upstreams, including raw upgraded sockets. They
prove transport preservation and lifecycle behavior, not authenticated native
multi-agent interoperability or reverse-direction release acceptance.

The additional [isolated native runners](gates/README.md) now exercise real Codex
v1/v2 spawning, code tools, parent delivery, v2 follow-up, WebSocket warmup and
continuation, and native HTTP fallback through this proxy. Their model upstreams
are fabricated. A separate live native Claude Sonnet parent/child/Read control also
passes through the existing Anthropic leg. Neither is a live Codex → Claude test.

```sh
node --import tsx --test test/integration/codex-ingress.test.ts
npm run check
bash scripts/smoke-tarball.sh
```
