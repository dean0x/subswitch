import { DEFAULT_PORT } from "./config.js";
import { PortSchema } from "./init.js";
import { classifyRelay, StopRequestLabelSchema, writeStopRequest, type ClassifyRelayDeps, type StopRequest } from "./relay-record.js";

const POLL_MS = 200;
const WAIT_MS = 35_000;
const MAX_POLLS = WAIT_MS / POLL_MS;
const MAX_OS_PID = 0x7fff_ffff;

type StopSignal = 0 | "SIGTERM";
type SignalResult = "ok" | "missing" | "denied" | "failed";

export interface StopRelayDeps {
  readonly home: string;
  readonly port?: string | undefined;
  readonly label?: string;
  readonly pid: number;
  readonly ppid: number;
  readonly uid: number | undefined;
  readonly kill: (pid: number, signal: StopSignal) => boolean;
  readonly requestHealth: NonNullable<ClassifyRelayDeps["requestHealth"]>;
  readonly clock: { now(): number; monotonic(): number };
  readonly sleep: (ms: number) => Promise<void>;
  readonly loadConfig: (options: { readonly allowProjectPort: false }) =>
    { readonly ok: true; readonly value: { readonly config: { readonly port: number } } } | { readonly ok: false };
  readonly out: (line: string) => void;
  readonly errOut: (line: string) => void;
}

function signalRelay(d: StopRelayDeps, pid: number, signal: StopSignal): SignalResult {
  if (!Number.isSafeInteger(pid) || pid < 2 || pid > MAX_OS_PID || pid === d.pid) return "failed";
  try {
    return d.kill(pid, signal) ? "ok" : "missing";
  } catch (error) {
    if (error instanceof Error && "code" in error) {
      if (error.code === "ESRCH") return "missing";
      if (error.code === "EPERM") return "denied";
    }
    return "failed";
  }
}

async function waitForExit(d: StopRelayDeps, pid: number): Promise<"exited" | "failed" | "timeout"> {
  const deadline = d.clock.monotonic() + WAIT_MS;
  for (let poll = 0; poll < MAX_POLLS; poll++) {
    const remaining = deadline - d.clock.monotonic();
    if (remaining <= 0) break;
    await d.sleep(Math.min(POLL_MS, remaining));
    if (d.clock.monotonic() > deadline) break;
    const state = signalRelay(d, pid, 0);
    if (state === "missing" || state === "denied") return "exited";
    if (state === "failed") return "failed";
  }
  return "timeout";
}

export async function stopRelay(d: StopRelayDeps): Promise<0 | 1> {
  const fail = (message: string): 1 => {
    d.errOut(`subswitch: ${message}`);
    return 1;
  };
  const label = StopRequestLabelSchema.optional().safeParse(d.label);
  if (!label.success) return fail("invalid --by: use 1 to 32 lowercase letters, digits, dots, underscores or dashes");

  const loaded = d.port === undefined ? d.loadConfig({ allowProjectPort: false }) : undefined;
  const parsed = PortSchema.safeParse(d.port ?? (loaded?.ok ? loaded.value.config.port : DEFAULT_PORT));
  if (!parsed.success) return fail("invalid --port: expected an integer between 1 and 65535");
  const port = parsed.data;
  const inactive = (): 0 => {
    d.out(`No relay is active on port ${port}.`);
    return 0;
  };
  const identify = () => classifyRelay(port, {
    home: d.home, requestHealth: d.requestHealth, confirmIdle: true,
    isAlive: (pid) => {
      const state = signalRelay(d, pid, 0);
      return state === "ok" || state === "denied";
    },
  });
  const check = await identify();

  switch (check.kind) {
    case "none": return inactive();
    case "legacy": return fail(`relay on port ${port} has no record; restart it before you use stop`);
    case "foreign": return fail(`a different listener uses port ${port}`);
    case "unverified":
      if (check.reason === "unsafe_path") return fail(`unsafe_path: cannot read relay record on port ${port}`);
      return signalRelay(d, check.record.pid, 0) === "missing" ? inactive() : fail(`relay on port ${port} is unverified`);
    case "verified": break;
    default: return check satisfies never;
  }

  const { pid, nonce, managedBy } = check.record;
  if (managedBy === "launchd") return fail(`launchd manages the relay on port ${port}; run subswitch service uninstall`);
  if (d.uid === undefined) return fail("could not identify the stop requester");
  const requestedAt = new Date(d.clock.now()).toJSON();
  if (requestedAt === null) return fail("could not set the stop request time");
  const request: StopRequest = {
    targetPid: pid, nonce, requesterPid: d.pid, requesterPpid: d.ppid, uid: d.uid,
    requestedAt, ...(label.data === undefined ? {} : { label: label.data }),
  };
  const written = await writeStopRequest(port, d.home, request);
  if (!written.ok) return fail(`could not write stop request on port ${port}`);
  d.errOut(`subswitch: stop request ${JSON.stringify(written.value)}`);

  // The record or listener can change while the request write awaits disk I/O.
  const latest = await identify();
  if (latest.kind !== "verified" || latest.record.pid !== pid || latest.record.nonce !== nonce || latest.record.managedBy !== managedBy) {
    return signalRelay(d, pid, 0) === "missing" ? inactive() : fail(`relay on port ${port} changed before stop`);
  }
  const sent = signalRelay(d, pid, "SIGTERM");
  if (sent === "missing") return 0;
  if (sent !== "ok") return fail(`could not signal the relay on port ${port}`);
  const wait = await waitForExit(d, pid);
  if (wait === "exited") return 0;
  if (wait === "failed") return fail(`could not check the relay on port ${port}`);
  return fail(`relay on port ${port} did not stop within 35 seconds`);
}
