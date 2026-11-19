// Reuse JSON.stringify for Chat Completions records, which have no event name.
export const chatSse = (chunks: readonly (object | "[DONE]")[]): string => chunks.map((chunk) =>
  `data: ${chunk === "[DONE]" ? chunk : JSON.stringify(chunk)}\n\n`).join("");

export const chatChunk = (delta: object = {}, finish_reason: string | null = null) => ({
  choices: [{ index: 0, delta, finish_reason }],
});
