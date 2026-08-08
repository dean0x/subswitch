/**
 * SSE parser throughput benchmark — not part of `npm test`.
 *
 * Run: `npm run bench:sse`  or directly:
 *   node --import tsx test/tools/sse-parser.bench.ts
 *
 * Measures `createSseParser` across three shapes:
 *
 *  1. Single large event  — no separator mid-stream; every chunk takes the rel===-1 path.
 *     Tests the accumulate-without-drain branch; a quadratic parser is 4× slower per
 *     doubling here.
 *
 *  2. Many small events   — many separators per chunk; the drain loop fires ~128 times per
 *     8 KiB chunk. Tests the main boundary-handling branch that every realistic Codex stream
 *     exercises.
 *
 *  3. Boundary-straddling events — each event is CHUNK_BYTES+1 bytes, so the closing `\n\n`
 *     always straddles consecutive chunks: one `\n` ends chunk N, the matching `\n` opens
 *     chunk N+1. Forces the carry logic (CARRY_CHARS=3) on every single event.
 *
 * Each shape is run at 2 / 4 / 8 MiB total data. The parser is driven synchronously
 * (`write` then drain via `read`) so timing reflects parser work, not stream scheduling.
 *
 * Linearity gate: growth per doubling must be ≤ MAX_RATIO_PER_DOUBLING. A linear parser
 * doubles; a quadratic one quadruples. The bench exits non-zero on regression so it can
 * eventually gate in `check` — do not wire it in yourself without running it in CI first.
 *
 * This file lives under `test/` so `tsc --noEmit` typechecks it, but outside
 * `test/unit` and `test/integration` so the `npm test` globs do not pick it up.
 */
import { createSseParser } from "../../src/codex-response.js";

const MIB = 1024 * 1024;
const CHUNK_BYTES = 8 * 1024;
const SIZES_MIB = [2, 4, 8] as const;
const ITERATIONS = 3;
const MAX_EVENT_BYTES = 64 * MIB;

/**
 * Maximum allowed median ratio per doubling of input size before flagging a regression.
 * A linear parser is ~2×; quadratic is ~4×. 3.5 sits halfway and gives enough slack for
 * environmental noise while still catching a real regression.
 */
const MAX_RATIO_PER_DOUBLING = 3.5;

/**
 * Minimum median (ms) below which the linearity check is skipped.
 * Sub-millisecond runs produce noisy ratios that would cause false positives.
 */
const MIN_MS_FOR_RATIO_CHECK = 1;

// ---------------------------------------------------------------------------
// Corpus builders
// ---------------------------------------------------------------------------

/** One SSE event of exactly `bytes` length: `data: <payload>\n\n`. */
const buildSingleEvent = (bytes: number): Buffer => {
  const prefix = "data: ";
  const suffix = "\n\n";
  const payloadLen = bytes - prefix.length - suffix.length;
  if (payloadLen < 0) throw new Error("size too small for one event");
  return Buffer.from(`${prefix}${"x".repeat(payloadLen)}${suffix}`);
};

/**
 * Many small events, each exactly 64 bytes: `data: <56-char payload>\n\n`.
 * At CHUNK_BYTES=8192 each chunk holds 128 complete events, so the drain loop is
 * exercised ~128× per `write()` call — the boundary-handling branch that realistic
 * Codex streams always hit.
 */
const buildManySmallEvents = (totalBytes: number): Buffer => {
  const EVENT_BYTES = 64;
  const prefix = "data: ";
  const suffix = "\n\n";
  const payloadLen = EVENT_BYTES - prefix.length - suffix.length;
  const singleEvent = `${prefix}${"x".repeat(payloadLen)}${suffix}`;
  const count = Math.floor(totalBytes / EVENT_BYTES);
  return Buffer.from(singleEvent.repeat(count));
};

/**
 * Boundary-straddling events, each CHUNK_BYTES+1 bytes.
 *
 * Layout per event (CHUNK_BYTES=8192, EVENT_BYTES=8193):
 *   chunk N:   `data: ` + `x`*8185 + `\n`   ← first half of the `\n\n` separator
 *   chunk N+1: `\n` + [start of next event]  ← second half of the `\n\n` separator
 *
 * Every event boundary forces the CARRY_CHARS=3 overlap look-back to find the separator,
 * exercising the carry logic that is otherwise hit only for pathological chunk alignments.
 */
const buildBoundaryStraddlingEvents = (totalBytes: number): Buffer => {
  const EVENT_BYTES = CHUNK_BYTES + 1; // 8193
  const prefix = "data: ";
  const suffix = "\n\n";
  const payloadLen = EVENT_BYTES - prefix.length - suffix.length;
  if (payloadLen < 0) throw new Error("CHUNK_BYTES too small for boundary-straddling shape");
  const singleEvent = `${prefix}${"x".repeat(payloadLen)}${suffix}`;
  const count = Math.floor(totalBytes / EVENT_BYTES);
  return Buffer.from(singleEvent.repeat(count));
};

// ---------------------------------------------------------------------------
// Driver
// ---------------------------------------------------------------------------

const splitChunks = (bytes: Buffer, chunkBytes: number): Buffer[] => {
  const chunks: Buffer[] = [];
  for (let offset = 0; offset < bytes.length; offset += chunkBytes) {
    chunks.push(bytes.subarray(offset, Math.min(offset + chunkBytes, bytes.length)));
  }
  return chunks;
};

/** Drive the parser synchronously and return elapsed milliseconds plus the event count. */
const driveOnce = (chunks: readonly Buffer[]): { readonly ms: number; readonly events: number } => {
  const parser = createSseParser(MAX_EVENT_BYTES);
  let events = 0;
  const drain = (): void => {
    // Events are counted, never inspected — the benchmark measures parser work only.
    // Bounded by the number of events the parser has produced, which is finite.
    for (let event: unknown = parser.read(); event !== null; event = parser.read()) {
      events += 1;
    }
  };
  const started = performance.now();
  for (const chunk of chunks) {
    parser.write(chunk);
    drain();
  }
  parser.end();
  drain();
  const ms = performance.now() - started;
  return { ms, events };
};

const median = (values: readonly number[]): number => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? Number.NaN;
};

// ---------------------------------------------------------------------------
// Linearity check
// ---------------------------------------------------------------------------

type ShapeResult = { readonly sizeMib: number; readonly medianMs: number };

/**
 * Check that median time grows no faster than MAX_RATIO_PER_DOUBLING per data doubling.
 * Returns violation messages (empty array = pass).
 */
const checkLinearity = (name: string, results: readonly ShapeResult[]): string[] => {
  const violations: string[] = [];
  for (let i = 1; i < results.length; i += 1) {
    const prev = results[i - 1];
    const curr = results[i];
    if (prev === undefined || curr === undefined) continue;
    if (prev.medianMs < MIN_MS_FOR_RATIO_CHECK) continue; // too fast to measure reliably
    const ratio = curr.medianMs / prev.medianMs;
    if (ratio > MAX_RATIO_PER_DOUBLING) {
      violations.push(
        `[${name}] ${prev.sizeMib}→${curr.sizeMib} MiB: ratio ${ratio.toFixed(2)}x exceeds ${MAX_RATIO_PER_DOUBLING}x (quadratic regression likely)`,
      );
    }
  }
  return violations;
};

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const runShape = (
  name: string,
  build: (bytes: number) => Buffer,
): ShapeResult[] => {
  process.stdout.write(`\n[${name}]\n`);
  const results: ShapeResult[] = [];
  for (const sizeMib of SIZES_MIB) {
    const buf = build(sizeMib * MIB);
    const chunks = splitChunks(buf, CHUNK_BYTES);
    const runs: number[] = [];
    let events = 0;
    for (let i = 0; i < ITERATIONS; i += 1) {
      const result = driveOnce(chunks);
      runs.push(result.ms);
      events = result.events;
    }
    const med = median(runs);
    results.push({ sizeMib, medianMs: med });
    const formatted = runs.map((ms) => ms.toFixed(1)).join(", ");
    process.stdout.write(
      `${String(sizeMib).padStart(2)} MiB  median ${med.toFixed(1)} ms  (runs: ${formatted})  events=${events}\n`,
    );
  }
  return results;
};

const main = (): void => {
  process.stdout.write(
    `chunk=${CHUNK_BYTES}B  iterations=${ITERATIONS}  max_ratio=${MAX_RATIO_PER_DOUBLING}x\n`,
  );

  const shapes: ReadonlyArray<{ readonly name: string; readonly build: (bytes: number) => Buffer }> = [
    { name: "single large event", build: buildSingleEvent },
    { name: "many small events", build: buildManySmallEvents },
    { name: "boundary-straddling events", build: buildBoundaryStraddlingEvents },
  ];

  const allViolations: string[] = [];
  for (const { name, build } of shapes) {
    const results = runShape(name, build);
    const violations = checkLinearity(name, results);
    allViolations.push(...violations);
  }

  process.stdout.write("\n");
  if (allViolations.length > 0) {
    process.stderr.write("LINEARITY REGRESSION DETECTED:\n");
    for (const v of allViolations) {
      process.stderr.write(`  ${v}\n`);
    }
    process.exit(1);
  }
  process.stdout.write(
    `linearity OK (all shapes within ${MAX_RATIO_PER_DOUBLING}x per doubling)\n`,
  );
};

main();
