import type { Item } from "../../src/routing/routing-types.js";

export const created = (model: string): Item => ({
  type: "response.created",
  response: { id: "resp_fixture", model, status: "in_progress", output: [] },
});

export const terminal = (model: string, output: Item[]): Item => ({
  type: "response.completed",
  response: { id: "resp_fixture", model, status: "completed", output,
    usage: { input_tokens: 37, output_tokens: 11 } },
});

export const responsesSse = (events: Item[]): string => events.map((event, sequence_number) =>
  `event: ${event["type"]}\ndata: ${JSON.stringify({ sequence_number, ...event })}\n\n`).join("");
