/**
 * SSE parser throughput benchmark — not part of `npm test`.
 *
 * Run: `node --import tsx test/tools/sse-parser.bench.ts`
 *
 * Measures the cost of feeding ONE oversized SSE event through `createSseParser`
 * in 8 KiB chunks. A single event is the adversarial shape for an accumulate-then-
 * scan parser: no separator is ever found mid-stream, so every chunk extends the
 * accumulator and nothing is ever drained. If the parser materialises the whole
 * accumulator per chunk, the cost is quadratic in stream length; if it defers
 * materialisation, it is linear. The 2/4/8 MiB ladder makes the difference legible
 * — a linear parser roughly doubles per step, a quadratic one roughly quadruples.
 *
 * The parser is driven synchronously (`write` then drain via `read`) rather than
 * through `pipeline`, so the number reflects parser work and not stream scheduling.
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

/** One SSE event of exactly `bytes` length: `data: <payload>\n\n`. */
const buildSingleEvent = (bytes: number): Buffer => {
  const prefix = "data: ";
  const suffix = "\n\n";
  const payloadLen = bytes - prefix.length - suffix.length;
  if (payloadLen < 0) throw new Error("size too small for one event");
  return Buffer.from(`${prefix}${"x".repeat(payloadLen)}${suffix}`);
};

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

const main = (): void => {
  process.stdout.write(`chunk=${CHUNK_BYTES}B iterations=${ITERATIONS}\n`);
  for (const sizeMib of SIZES_MIB) {
    const chunks = splitChunks(buildSingleEvent(sizeMib * MIB), CHUNK_BYTES);
    const runs: number[] = [];
    let events = 0;
    for (let i = 0; i < ITERATIONS; i += 1) {
      const result = driveOnce(chunks);
      runs.push(result.ms);
      events = result.events;
    }
    const formatted = runs.map((ms) => ms.toFixed(1)).join(", ");
    process.stdout.write(
      `${String(sizeMib).padStart(2)} MiB  median ${median(runs).toFixed(1)} ms  (runs: ${formatted})  events=${events}\n`,
    );
  }
};

main();
