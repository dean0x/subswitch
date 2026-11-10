/** Opt-in, read-only contract probe. Inference is a normal request, never quota exhaustion. */
import { parseArgs } from "node:util";
import { destinationUrl, defaultBase } from "../../src/routing/destination-catalog.js";
import { readBoundedBody } from "../../src/provider-transport.js";
import { createSseParser, type SseEvent } from "../../src/codex-response.js";
import { Readable } from "node:stream";
import { object } from "../../src/plain-object.js";
import type { AccessProfile } from "../../src/routing/routing-types.js";

const { values } = parseArgs({ options: { product: { type: "string" }, region: { type: "string" }, protocol: { type: "string" },
  usage: { type: "boolean" }, "non-stream": { type: "boolean" } }, strict: true });
const product = values.product ?? "kimi-code", region = values.region ?? "global", protocol = values.protocol ?? "messages";
if (!["kimi-code", "kimi-platform"].includes(product) || !["global", "mainland-cn"].includes(region) || !["messages", "responses"].includes(protocol))
  throw new Error("Use --product kimi-code|kimi-platform --region global|mainland-cn --protocol messages|responses");
const credentialName = product === "kimi-code" ? "SUBSWITCH_KIMI_CODE_KEY" : "SUBSWITCH_KIMI_PLATFORM_KEY";
const key = process.env[credentialName];
const profile: AccessProfile = { provider: "kimi", product: product as "kimi-code" | "kimi-platform", region: region as "global" | "mainland-cn",
  billing: product === "kimi-code" ? "subscription" : "api", account: "probe", credential: { kind: "env", name: credentialName } };
const baseReport = { schemaVersion: 1, date: new Date().toISOString(), source: "manual-cloud-probe", product, region,
  credentialKind: product === "kimi-code" ? "coding-plan-key" : "api-key", protocol, inferenceSimulated: false };
if (!key) {
  console.log(JSON.stringify({ ...baseReport, result: "unresolved", reason: "credential_missing", success: false })); process.exitCode = 2;
} else {
  try {
    if (values.usage) {
      if (product !== "kimi-code") throw new Error("usage_product_mismatch");
      const response = await fetch(`${defaultBase(profile)}/usages`, { headers: { authorization: `Bearer ${key}` }, redirect: "error", signal: AbortSignal.timeout(8000) });
      const body = await readBoundedBody(response.body, 65536, AbortSignal.timeout(8000));
      let json = false; try { json = !!object(JSON.parse(body.text)); } catch { /* Never print body. */ }
      console.log(JSON.stringify({ ...baseReport, protocol: "cloud-usage", status: response.status, complete: body.complete, json,
        success: response.ok && body.complete && json, result: response.ok ? "observed-envelope-only" : "metadata-path-rejected",
        usageDriverEnabled: false }));
      process.exitCode = response.ok && body.complete && json ? 0 : 1;
    } else {
      const model = product === "kimi-code" ? "k3" : "kimi-k3", stream = values["non-stream"] !== true;
      const body = protocol === "messages" ? { model, max_tokens: 128, stream, messages: [{ role: "user", content: "Reply with the word ready." }], output_config: { effort: "high" } } :
        { model, stream, store: false, input: [{ role: "user", content: "Reply with the word ready." }], reasoning: { effort: "high" }, max_output_tokens: 128 };
      const response = await fetch(destinationUrl(profile, protocol as "messages" | "responses"), { method: "POST", redirect: "error",
        headers: { authorization: `Bearer ${key}`, "content-type": "application/json", "anthropic-version": "2023-06-01" },
        body: JSON.stringify(body), signal: AbortSignal.timeout(60000) });
      let validTerminal = false, events = 0, ordering = true;
      if (!response.ok) await readBoundedBody(response.body, 65536, AbortSignal.timeout(8000));
      else if (!stream) {
        const parsed = await readBoundedBody(response.body, 65536, AbortSignal.timeout(60000));
        let final; try { final = object(JSON.parse(parsed.text)); } catch { /* Unknown envelope. */ }
        validTerminal = parsed.complete && (protocol === "messages" ? final?.["stop_reason"] === "end_turn" : final?.["status"] === "completed");
      } else if (response.body) {
        const source = Readable.fromWeb(response.body as import("node:stream/web").ReadableStream<Uint8Array>), parser = createSseParser(4 * 1024 * 1024);
        source.on("error", error => parser.destroy(error)); source.pipe(parser);
        try {
          for await (const event of parser as AsyncIterable<SseEvent>) {
            if (event.data === "[DONE]") continue;
            const value = object(JSON.parse(event.data)); const type = value?.["type"];
            if (type === "ping") continue;
            if (events++ === 0) ordering = type === (protocol === "messages" ? "message_start" : "response.created");
            if (type === "message_stop" || type === "response.completed") { validTerminal = true; break; }
          }
        } finally { source.destroy(); parser.destroy(); }
      }
      const success = response.ok && ordering && validTerminal;
      console.log(JSON.stringify({ ...baseReport, model, stream, effort: "high", status: response.status, events, ordering, validTerminal,
        success, result: success ? "live-observed-basic-protocol" : "protocol-gate-failed", toolsVerified: false, equivalenceVerified: false }));
      process.exitCode = success ? 0 : 1;
    }
  } catch { console.log(JSON.stringify({ ...baseReport, success: false, result: "probe_failed", reason: "transport_or_contract_error" })); process.exitCode = 1; }
}
