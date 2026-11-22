import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { TestContext } from "node:test";
import { startRelayChild, type RelayChild, type RelayChildOptions } from "./relay-child.js";

export async function launch(t: TestContext, options: Omit<RelayChildOptions, "env"> & { readonly env?: NodeJS.ProcessEnv } = {}) {
  const relay = await startRelayChild({
    ...options, env: { NO_COLOR: "1", SUBSWITCH_LIMIT_RECORDING: "0", ...options.env },
  });
  t.after(relay.cleanup);
  return relay;
}

export const state = (relay: RelayChild) => join(relay.folders.home, ".cache", "subswitch", "relay", String(relay.port));
export const log = (relay: RelayChild) => readFile(join(state(relay), "relay.log"), "utf8");
export const lifecycleLines = (text: string) => text.split("\n").filter((line) => /event=relay_(fatal|stopped)\b/.test(line));
export const iso = String.raw`\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z`;
export const stopped = (pid: number | undefined, code: number, signal?: string, requester = "") =>
  new RegExp(`^${iso} level=info event=relay_stopped pid=${pid}${signal === undefined ? "" : ` signal=${signal}`} exitCode=${code}${requester}$`);
