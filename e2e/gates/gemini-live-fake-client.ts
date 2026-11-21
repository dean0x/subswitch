// run-action starts this client in place of Claude Code. Each invocation sends one request.
import { readdir } from "node:fs/promises";
import { readBoundedBody } from "../../src/provider-transport.js";

async function run(): Promise<number> {
  const files = await readdir(".");
  if (files.length !== 1 || files[0] !== "package.json") return 2;
  const [port, model, prompt, expected] = process.argv.slice(2);
  if (port === undefined || !/^\d{1,5}$/.test(port) || model === undefined || prompt === undefined || expected === undefined) return 2;
  const base = URL.parse(process.env["ANTHROPIC_BASE_URL"] ?? "");
  if (base === null || base.origin !== `http://127.0.0.1:${port}` || base.username !== "" || base.password !== "" ||
    base.search !== "" || base.hash !== "" || !/^\/__subswitch\/action\/[a-f0-9-]{36}\/ingress$/.test(base.pathname)) return 2;
  const signal = AbortSignal.timeout(30_000);
  const response = await fetch(new URL(`${base.pathname}/v1/messages`, base), {
    method: "POST", redirect: "error", signal,
    headers: { "content-type": "application/json", "anthropic-version": "2023-06-01" },
    body: JSON.stringify({ model, max_tokens: 32, stream: true, messages: [{ role: "user", content: prompt }] }),
  });
  if (!response.ok || response.body === null) { await response.body?.cancel(); return 1; }
  if (prompt === "test-data-cancel") {
    // A nonzero exit tells run-action to cancel the action and its active request.
    const first = await response.body.getReader().read();
    return !first.done && first.value.byteLength > 0 ? 42 : 1;
  }
  const reply = await readBoundedBody(response.body, 1024 * 1024, signal);
  return reply.complete && reply.text.includes(expected) && reply.text.includes("event: message_stop") ? 0 : 1;
}

process.exit(await run().catch(() => 1));
