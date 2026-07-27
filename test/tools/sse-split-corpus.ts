/**
 * Exhaustive-split corpus and driver for `createSseParser`.
 *
 * Shared by the generator (`test/tools/gen-sse-splits-golden.ts`) and the assertion
 * test (`test/unit/sse-split-golden.test.ts`) so the two can never drift. This file
 * deliberately contains NO expected values — it only produces observations. The
 * expectations live in `test/fixtures/sse-splits.golden.json`, captured once against
 * the pre-rewrite parser. An oracle that recomputed the expectation from the parser
 * under test would prove nothing.
 *
 * It sits in `test/tools/` (not `test/unit/`) so `npm test`'s `test/unit/*.test.ts`
 * glob does not pick it up, while `tsc --noEmit` still typechecks it.
 */
import { readdirSync, readFileSync } from "node:fs";
import { createSseParser, type SseEvent } from "../../src/codex-response.js";

/** Well above every corpus entry, so the size bound never trips during a split sweep. */
export const GOLDEN_MAX_EVENT_BYTES = 1024 * 1024;

/** `SseEvent` with `event: undefined` rendered as `null` so it survives JSON round-trips. */
export interface GoldenEvent {
  readonly event: string | null;
  readonly data: string;
}

export interface CorpusEntry {
  readonly name: string;
  readonly bytes: Buffer;
}

export interface EntryObservation {
  readonly byteLength: number;
  readonly twoWaySplits: number;
  readonly threeWaySplits: number;
  readonly events: readonly GoldenEvent[];
}

export interface HandBuiltObservation {
  readonly chunks: readonly string[];
  readonly events: readonly GoldenEvent[];
}

export interface Observations {
  readonly entries: Readonly<Record<string, EntryObservation>>;
  readonly handBuilt: Readonly<Record<string, HandBuiltObservation>>;
}

const normalize = (event: SseEvent): GoldenEvent => ({ event: event.event ?? null, data: event.data });

/**
 * Drive the parser synchronously: write each chunk, drain the readable side, then end
 * and drain again so `flush()`'s residual event is captured too (verified: the flush
 * output is available to a synchronous `read()` after `end()`).
 *
 * Synchronous rather than `pipeline`-based because the sweep performs ~66k drives —
 * one microtask chain per drive would dominate the runtime.
 */
export const driveParser = (chunks: readonly Buffer[], maxEventBytes = GOLDEN_MAX_EVENT_BYTES): GoldenEvent[] => {
  const parser = createSseParser(maxEventBytes);
  const events: GoldenEvent[] = [];
  // Bounded: each iteration consumes one already-produced object from the readable buffer.
  const drain = (): void => {
    for (let read: unknown = parser.read(); read !== null; read = parser.read()) {
      events.push(normalize(read as SseEvent));
    }
  };
  for (const chunk of chunks) {
    parser.write(chunk);
    drain();
  }
  parser.end();
  drain();
  return events;
};

/**
 * Synthetic entries covering every separator form the regex `\r?\n\r?\n` admits, plus
 * the shapes a boundary scan can get wrong. The CRLF entries are the load-bearing ones:
 * only a 4-character separator can begin 3 characters before the end of the accumulator,
 * so they are the sole discriminator for the carry/slack width.
 */
const SYNTHETIC: readonly (readonly [string, string])[] = [
  ["sep-lf", "data: a\n\ndata: b\n\n"],
  ["sep-crlf", "data: a\r\n\r\ndata: b\r\n\r\n"],
  ["sep-cr-lf-lf", "data: a\r\n\ndata: b\r\n\n"],
  ["sep-lf-cr-lf", "data: a\n\r\ndata: b\n\r\n"],
  ["sep-back-to-back", "data: a\n\n\n\ndata: b\n\n"],
  ["sep-leading", "\n\ndata: a\n\n"],
  ["sep-trailing", "data: a\n\ndata: b\n\n\n\n"],
  ["comment-only-block", ": keepalive\n\ndata: a\n\n"],
  ["crlf-multiline-data", 'event: e1\r\ndata: {"a":\r\ndata: 1}\r\n\r\nevent: e2\r\ndata: x\r\n\r\n'],
  ["no-trailing-separator", "data: a\n\ndata: tail-without-separator"],
  ["mixed-crlf-and-lf", "event: first\r\ndata: one\r\n\r\nevent: second\ndata: two\n\n"],
  // A 4-byte codepoint inside the payload: the two-way sweep splits it at every internal
  // byte offset, which is the StringDecoder continuation path.
  ["utf8-four-byte", "data: \u{1F600} ok\n\ndata: b\n\n"],
];

/** Every recorded `.sse` fixture plus the synthetic separator set, in a stable order. */
export const buildCorpus = (): CorpusEntry[] => {
  const dir = new URL("../fixtures/response/", import.meta.url);
  const files = readdirSync(dir)
    .filter((name) => name.endsWith(".sse"))
    .sort();
  const fromFixtures = files.map((name) => ({ name: `fixture:${name}`, bytes: readFileSync(new URL(name, dir)) }));
  const fromSynthetic = SYNTHETIC.map(([name, text]) => ({ name: `synthetic:${name}`, bytes: Buffer.from(text) }));
  return [...fromFixtures, ...fromSynthetic];
};

/**
 * The smallest recorded fixture. Three-way splits are swept over this one only: the
 * count is quadratic in length, and a 317-byte input keeps it at ~50k drives.
 */
export const THREE_WAY_ENTRY = "fixture:failed.sse";

/**
 * Separators spanning three chunks, hand-built because a two-way sweep cannot produce
 * them for a separator at the very start of the stream. `["\r", "\n\r", "\n"]` is the
 * degenerate case: a bare 4-character separator delivered one or two characters at a time.
 */
export const HAND_BUILT: readonly (readonly [string, readonly string[]])[] = [
  ["bare-separator-across-three-chunks", ["\r", "\n\r", "\n"]],
  ["crlf-separator-across-three-chunks", ["event: a\r\ndata: 1\r", "\n\r", "\nevent: b\r\ndata: 2\r\n\r\n"]],
  ["separator-final-char-alone", ["event: a\r\ndata: 1\r\n\r", "\nevent: b\r\ndata: 2\r\n\r\n"]],
];

/**
 * Observe the whole corpus.
 *
 * For each entry the recorded `events` are the sequence produced by the UNSPLIT input.
 * Every two-way split (and, for `THREE_WAY_ENTRY`, every three-way split) is then driven
 * and required to produce that same sequence — split-invariance is the property being
 * pinned, and recording one sequence per entry rather than one per split keeps the golden
 * a few KB instead of tens of MB while asserting strictly more.
 *
 * A disagreement throws with the offending split indices rather than being folded into
 * the golden, so a real boundary defect can never be captured as an expectation.
 */
export const observe = (): Observations => {
  const entries: Record<string, EntryObservation> = {};
  for (const { name, bytes } of buildCorpus()) {
    const expected = driveParser([bytes]);
    const expectedJson = JSON.stringify(expected);

    let twoWaySplits = 0;
    for (let i = 1; i < bytes.length; i += 1) {
      const actual = driveParser([bytes.subarray(0, i), bytes.subarray(i)]);
      if (JSON.stringify(actual) !== expectedJson) {
        throw new Error(`${name}: two-way split at ${i} diverges from the unsplit drive`);
      }
      twoWaySplits += 1;
    }

    let threeWaySplits = 0;
    if (name === THREE_WAY_ENTRY) {
      for (let i = 1; i < bytes.length - 1; i += 1) {
        for (let j = i + 1; j < bytes.length; j += 1) {
          const actual = driveParser([bytes.subarray(0, i), bytes.subarray(i, j), bytes.subarray(j)]);
          if (JSON.stringify(actual) !== expectedJson) {
            throw new Error(`${name}: three-way split at ${i}/${j} diverges from the unsplit drive`);
          }
          threeWaySplits += 1;
        }
      }
    }

    entries[name] = { byteLength: bytes.length, twoWaySplits, threeWaySplits, events: expected };
  }

  const handBuilt: Record<string, HandBuiltObservation> = {};
  for (const [name, chunks] of HAND_BUILT) {
    handBuilt[name] = { chunks, events: driveParser(chunks.map((c) => Buffer.from(c))) };
  }

  return { entries, handBuilt };
};

/** Total drives the sweep performs — reported in the test name so a shrinking corpus is visible. */
export const totalSplits = (observations: Observations): { readonly twoWay: number; readonly threeWay: number } => {
  let twoWay = 0;
  let threeWay = 0;
  for (const entry of Object.values(observations.entries)) {
    twoWay += entry.twoWaySplits;
    threeWay += entry.threeWaySplits;
  }
  return { twoWay, threeWay };
};
