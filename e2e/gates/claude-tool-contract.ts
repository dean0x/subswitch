/** Experimental direct tool contract. Native preamble is captured, never synthesized or persisted. */
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { withNativeClaudeCapture } from "./claude-system-control.js";
import { object } from "./probe.js";
import { nativeGateFailureReport, type NativeDiagnosticOptions } from "./native-process.js";

export async function runClaudeToolContract(options?: NativeDiagnosticOptions) {
  return withNativeClaudeCapture(async (capture, originalHeaders, scope) => {
    const system = (capture.body["system"] as unknown[]).filter(value => {
      const text = object(value)?.["text"];
      return typeof text === "string" && /^(You are Claude Code,|You are a Claude agent,)/.test(text);
    });
    if (system.length !== 1) throw new Error("native_identity_missing");
    const headers = { ...originalHeaders, "anthropic-beta": "claude-code-20250219,oauth-2025-04-20" };
    const results: { stage: string; httpStatus: number; valid: boolean; errorType?: string }[] = [];
    const post = async (stage: string, body: Record<string, unknown>) => {
      const response = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST", headers, body: JSON.stringify(body), redirect: "error", signal: AbortSignal.timeout(30000),
      });
      const reader = response.body?.getReader();
      if (!reader) throw new Error("missing_body");
      const parts: Buffer[] = []; let size = 0;
      try {
        while (true) {
          const { done, value } = await reader.read(); if (done) break;
          size += value.byteLength; if (size > 1024 * 1024) throw new Error("body_limit"); parts.push(Buffer.from(value));
        }
      } finally { await reader.cancel(); }
      const parsed = object(JSON.parse(Buffer.concat(parts).toString("utf8")));
      const type = object(parsed?.["error"])?.["type"];
      results.push({ stage, httpStatus: response.status, valid: false,
        ...(typeof type === "string" && ["rate_limit_error", "invalid_request_error", "authentication_error"].includes(type) ? { errorType: type } : {}) });
      return response.ok ? parsed : undefined;
    };
    const request = {
      model: "claude-sonnet-5", max_tokens: 1024,
      system: [...system, { type: "text", text: "Execute the supplied compatibility task. Use only the supplied tools. Preserve the user's instructions and report the tool result exactly." }],
      messages: [{ role: "user", content: "Call read_fixture with path check.txt, then report its returned content exactly. You do not know the content until the tool returns." }],
      tools: [{ name: "read_fixture", description: "Read a named fixture in the isolated working directory.",
        input_schema: { type: "object", properties: { path: { type: "string" } }, required: ["path"], additionalProperties: false } }],
      tool_choice: { type: "tool", name: "read_fixture" },
    };
    const first = await post("tool_call", request);
    const calls = Array.isArray(first?.["content"]) ? first["content"].map(object).filter(block => block?.["type"] === "tool_use") : [];
    const call = calls[0];
    if (first?.["stop_reason"] !== "tool_use" || calls.length !== 1 || call?.["name"] !== "read_fixture" ||
      typeof call["id"] !== "string" || object(call["input"])?.["path"] !== "check.txt") {
      scope.markFailure();
      return { schemaVersion: 1, success: false, nativePreambleUsed: true, results };
    }
    results[0]!.valid = true;
    // The result is generated only after the requested tool has been validated.
    const value = `tool-result-${randomUUID()}`;
    const next = await post("tool_continuation", { ...request, tool_choice: { type: "none" },
      messages: [...request.messages, { role: "assistant", content: first["content"] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: call["id"], content: value }] }],
    });
    const text = Array.isArray(next?.["content"]) ? next["content"].map(object).filter(block => block?.["type"] === "text")
      .map(block => block?.["text"]).join("") : "";
    results[1]!.valid = next?.["stop_reason"] === "end_turn" && text === value;
    const success = results.every(result => result.valid);
    if (!success) scope.markFailure();
    return { schemaVersion: 1, success, nativePreambleUsed: true, results };
  }, options);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { const report = await runClaudeToolContract({ onDiagnostic: diagnostic => { process.stderr.write(JSON.stringify(diagnostic) + "\n"); } });
    console.log(JSON.stringify(report)); process.exitCode = report.success ? 0 : 1; }
  catch (error) { console.log(JSON.stringify({ schemaVersion: 1, success: false, code: "tool_contract_unavailable",
    ...nativeGateFailureReport(error) })); process.exitCode = 2; }
}
