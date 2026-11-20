// The fake client of the Kimi dry run. `run-action` starts it in place of Claude Code.
// It sends one Kimi request to the base URL that `run-action` gave it, as Claude Code
// does, reads the whole reply, and exits 0 only for a complete 200 stream. It sends no
// credential and reads no file.
const base = process.env.ANTHROPIC_BASE_URL;
const cap = Number(process.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS);
if (typeof base !== "string" || !base.startsWith("http://127.0.0.1:") || !Number.isSafeInteger(cap)) process.exit(2);

const response = await fetch(`${base}/v1/messages`, {
  method: "POST",
  redirect: "error",
  signal: AbortSignal.timeout(30_000),
  headers: { "content-type": "application/json", "anthropic-version": "2023-06-01" },
  body: JSON.stringify({
    model: "kimi-for-coding", max_tokens: cap, stream: true,
    messages: [{ role: "user", content: "Reply with the single word ready." }],
  }),
});
const text = await response.text();
process.exit(response.status === 200 && text.includes("event: message_stop") ? 0 : 1);
