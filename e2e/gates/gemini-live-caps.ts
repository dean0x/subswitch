import { z } from "zod";
import { GEMINI_BOOTSTRAP_PATH, GEMINI_DEFAULT_HOST } from "../../src/gemini-constants.js";
import { err, ok, type Result } from "../../src/result.js";

const ORIGIN = `https://${GEMINI_DEFAULT_HOST}`;
export const BOOTSTRAP_URL = `${ORIGIN}${GEMINI_BOOTSTRAP_PATH}`;
export const GENERATE_URL = `${ORIGIN}/v1internal:streamGenerateContent?alt=sse`;
export const PROBE_MS = 30_000;
export const PROBE_BYTES = 1024 * 1024;
export const REQUEST_MS = 60_000;
export const SESSION_MS = 5 * 60_000;
export const CAPS = Object.freeze({
  probe: Object.freeze({ load: 1, generate: 3, output: 64, thinking: 0 }),
  session: Object.freeze({ load: 0, generate: 6, output: 2048, thinking: 1024 }),
  cancel: 1,
});

const count = (limit: number) => z.number().int().min(0).max(limit);
const phaseCounts = (limits: { load: number; generate: number; output: number; thinking: number }) => z.strictObject({
  load: count(limits.load), generate: count(limits.generate), output: count(limits.output), thinking: count(limits.thinking),
});
export const CountsSchema = z.strictObject({ probe: phaseCounts(CAPS.probe), session: phaseCounts(CAPS.session), cancel: count(CAPS.cancel) });
type Counts = z.infer<typeof CountsSchema>;
export const emptyCounts = (): Counts => ({
  probe: { load: 0, generate: 0, output: 0, thinking: 0 }, session: { load: 0, generate: 0, output: 0, thinking: 0 }, cancel: 0,
});

export interface RequestBudget {
  readonly phase: "probe" | "session";
  readonly output: number;
  readonly thinking: number;
  readonly tools: boolean;
  /** A deadline on the monotonic clock. */
  readonly deadline: number;
}

export type CapCode = "broken_cap" | "cost_cap";
export const createLedger = (initial: Counts = emptyCounts()) => {
  let used = { ...initial, probe: { ...initial.probe }, session: { ...initial.session } };
  let bytes = 0;
  let failure: CapCode | undefined;
  const stop = new AbortController();
  const refuse = (code: CapCode): Result<never, CapCode> => {
    failure ??= code;
    stop.abort(new Error(failure));
    return err(failure);
  };

  return {
    get used(): Counts { return { ...used, probe: { ...used.probe }, session: { ...used.session } }; },
    get failure(): CapCode | undefined { return failure; },
    signal: stop.signal,
    reserve(kind: "load" | "generate", budget: RequestBudget): Result<void, CapCode> {
      if (failure !== undefined) return err(failure);
      if (!CountsSchema.safeParse(used).success || !Number.isSafeInteger(budget.output) || budget.output < 1 ||
        !Number.isSafeInteger(budget.thinking) || budget.thinking < 0 || !Number.isFinite(budget.deadline)) return refuse("broken_cap");
      if (performance.now() >= budget.deadline || (budget.phase === "probe" && budget.tools)) return refuse("cost_cap");
      const old = used[budget.phase];
      const next = kind === "load" ? { ...old, load: old.load + 1 } : {
        ...old, generate: old.generate + 1, output: old.output + budget.output, thinking: old.thinking + budget.thinking,
      };
      const snapshot = { ...used, [budget.phase]: next };
      if (!CountsSchema.safeParse(snapshot).success) return refuse("cost_cap");
      used = snapshot;
      return ok(undefined);
    },
    reserveCancel(): Result<void, CapCode> {
      if (failure !== undefined) return err(failure);
      if (!CountsSchema.safeParse(used).success) return refuse("broken_cap");
      if (used.cancel >= CAPS.cancel) return refuse("cost_cap");
      used = { ...used, cancel: used.cancel + 1 };
      return ok(undefined);
    },
    reserveBytes(size: number): Result<void, CapCode> {
      if (failure !== undefined) return err(failure);
      if (!Number.isSafeInteger(size) || size < 0 || !Number.isSafeInteger(bytes) || bytes < 0) return refuse("broken_cap");
      if (size > PROBE_BYTES - bytes) return refuse("cost_cap");
      bytes += size;
      return ok(undefined);
    },
    refuse,
  };
};
type Ledger = ReturnType<typeof createLedger>;

/** This send boundary accepts only the two planned operations. It never follows redirects. */
export const cappedFetch = (ledger: Ledger, current: () => RequestBudget | undefined, transport: typeof fetch): typeof fetch =>
  async (input, init) => {
    const budget = current();
    if (budget === undefined) { ledger.refuse("broken_cap"); throw new Error("broken_cap"); }
    if ((input !== BOOTSTRAP_URL && input !== GENERATE_URL) || init?.method !== "POST" || typeof init.body !== "string" ||
      (budget.phase === "probe" && Buffer.byteLength(init.body) > PROBE_BYTES)) {
      ledger.refuse("cost_cap");
      throw new Error("cost_cap");
    }
    const reserved = ledger.reserve(input === BOOTSTRAP_URL ? "load" : "generate", budget);
    if (!reserved.ok) throw new Error(reserved.error);
    const time = Math.min(budget.phase === "probe" ? PROBE_MS : REQUEST_MS, Math.ceil(budget.deadline - performance.now()));
    if (time < 1 || init.signal?.aborted) { ledger.refuse("cost_cap"); throw new Error("cost_cap"); }
    const deadline = AbortSignal.timeout(time);
    const signal = AbortSignal.any([deadline, ledger.signal, ...(init.signal == null ? [] : [init.signal])]);
    const response = await transport(input, { ...init, redirect: "error", signal });
    if (response.redirected) {
      void response.body?.cancel().catch(() => undefined);
      ledger.refuse("broken_cap");
      throw new Error("broken_cap");
    }
    if (budget.phase !== "probe" || response.body === null) return response;
    const readable = response.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        const size = ledger.reserveBytes(chunk.byteLength);
        if (!size.ok) throw new Error(size.error);
        controller.enqueue(chunk);
      },
    }), { signal });
    return new Response(readable, { status: response.status, headers: response.headers });
  };
