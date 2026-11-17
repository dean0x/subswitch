/** Borrowed ranges in our own bounded canonical envelope, never a JSON validator
 * or replay admission policy. No parsing, string copies, hashes or retained data. */
export type Span = readonly [start: number, end: number];
type PrefixParts = readonly [controls: Span, earlierMessages: Span, assistant: Span];
const maxChars = 32 * 1024 * 1024;

function stringEnd(text: string, start: number, limit: number): number | undefined {
  if (text.charCodeAt(start) !== 34) return;
  for (let i = start + 1; i < limit; i++) {
    if (text.charCodeAt(i) === 92) i++;
    else if (text.charCodeAt(i) === 34) return i + 1;
  }
  return;
}
function valueEnd(text: string, start: number, limit: number): number | undefined {
  const first = text.charCodeAt(start);
  if (first === 34) return stringEnd(text, start, limit);
  if (first !== 123 && first !== 91) {
    let end = start;
    while (end < limit && ![44, 93, 125].includes(text.charCodeAt(end))) end++;
    return end > start ? end : undefined;
  }
  const stack: number[] = [];
  let quoted = false;
  for (let i = start; i < limit; i++) {
    const code = text.charCodeAt(i);
    if (quoted) {
      if (code === 92) { i++; continue; }
      if (code === 34) quoted = false;
    } else if (code === 34) quoted = true;
    else if (code === 123 || code === 91) {
      if (stack.length === 128) return;
      stack.push(code);
    } else if (code === 125 || code === 93) {
      if (stack.pop() !== (code === 125 ? 123 : 91)) return;
      if (!stack.length) return i + 1;
    }
  }
  return;
}
export function prefixParts(text: string): PrefixParts | undefined {
  const head = '{"controls":', middle = ',"messages":[';
  if (text.length > maxChars || !text.startsWith(head) || text.charCodeAt(head.length) !== 123) return;
  const controlsEnd = valueEnd(text, head.length, text.length);
  if (controlsEnd === undefined || !text.startsWith(middle, controlsEnd)) return;
  const first = controlsEnd + middle.length;
  let start = first;
  for (;;) {
    if (text.charCodeAt(start) !== 123) return;
    const end = valueEnd(text, start, text.length);
    if (end === undefined) return;
    if (text.startsWith("]}", end) && end + 2 === text.length)
      return [[head.length, controlsEnd], [first, start === first ? first : start - 1], [start, end]];
    if (text.charCodeAt(end) !== 44) return;
    start = end + 1;
  }
}
export function samePart(left: string, a: Span, right: string, b: Span): boolean {
  const length = a[1] - a[0];
  if (length !== b[1] - b[0]) return false;
  for (let i = 0; i < length; i++) if (left.charCodeAt(a[0] + i) !== right.charCodeAt(b[0] + i)) return false;
  return true;
}

const knownFields = ["role", "type", "text", "id", "name", "input", "tool_use_id", "content", "is_error", "citations"] as const;
type KnownField = typeof knownFields[number];
type Shape = "string" | "array" | "object" | "number" | "boolean" | "null" | "missing" | "unknown";
type Field = KnownField | "none" | "message_count" | "content_shape" | "block_count" | "other" | "limit" | "unavailable";
export interface EarlierDifference {
  readonly messageIndex: number | null;
  readonly blockIndex: number | null;
  readonly field: Field;
  readonly beforeShape: Shape;
  readonly afterShape: Shape;
  /** Only equality of string content or one text block; never concatenates blocks. */
  readonly sameText: boolean | null;
}
function shape(text: string, span: Span | undefined): Shape {
  if (!span) return "missing";
  const code = text.charCodeAt(span[0]);
  return code === 34 ? "string" : code === 91 ? "array" : code === 123 ? "object" :
    code === 110 ? "null" : code === 116 || code === 102 ? "boolean" : code === 45 || code >= 48 && code <= 57 ? "number" : "unknown";
}
/** Only known schema keys become labels; nested caller tool data stays opaque. */
function fields(text: string, span: Span): Partial<Record<KnownField, Span>> | undefined {
  if (shape(text, span) !== "object") return;
  const result: Partial<Record<KnownField, Span>> = {};
  let start = span[0] + 1;
  while (start < span[1] - 1) {
    const key = knownFields.find(key => text.startsWith(JSON.stringify(key) + ":", start));
    if (!key || result[key]) return;
    const value = start + key.length + 3, end = valueEnd(text, value, span[1] - 1);
    if (end === undefined) return;
    result[key] = [value, end];
    if (end === span[1] - 1) return result;
    if (text.charCodeAt(end) !== 44) return;
    start = end + 1;
  }
  return start === span[1] - 1 ? result : undefined;
}
class ComparisonLimit extends Error {}
function* elements(text: string, range: Span): Generator<Span> {
  let start = range[0], count = 0;
  while (start < range[1]) {
    if (count++ === 256) throw new ComparisonLimit();
    const end = valueEnd(text, start, range[1]);
    if (end === undefined) throw Error("comparison_unavailable");
    yield [start, end];
    if (end === range[1]) return;
    if (text.charCodeAt(end) !== 44) throw Error("comparison_unavailable");
    start = end + 1;
    if (start === range[1]) throw Error("comparison_unavailable");
  }
}
function singleText(text: string, span: Span): Span | undefined {
  if (shape(text, span) === "string") return span;
  if (shape(text, span) !== "array") return;
  const iterator = elements(text, [span[0] + 1, span[1] - 1]), one = iterator.next();
  if (one.done || !iterator.next().done) return;
  const block = fields(text, one.value);
  if (!block?.type || !text.startsWith('"text"', block.type[0]) || block.type[1] - block.type[0] !== 6 || !block.text) return;
  if (Object.keys(block).some(key => !["type", "text", "citations"].includes(key))) return;
  if (block.citations && !(["null", "[]"].some(value => text.startsWith(value, block.citations![0]) && value.length === block.citations![1] - block.citations![0]))) return;
  return shape(text, block.text) === "string" ? block.text : undefined;
}

/** First differing earlier message, then known field/block. Every index<=255;
 * unknown framing/depth/field gives unavailable, exhaustion gives limit. */
export function earlierDifference(prior: string | undefined, current: string): EarlierDifference {
  const fact = (field: Field, messageIndex: number | null = null, blockIndex: number | null = null,
    beforeShape: Shape = "unknown", afterShape: Shape = "unknown", sameText: boolean | null = null): EarlierDifference =>
    ({ messageIndex, blockIndex, field, beforeShape, afterShape, sameText });
  try {
    if (prior === undefined) return fact("unavailable");
    const left = prefixParts(prior), right = prefixParts(current);
    if (!left || !right) return fact("unavailable");
    const a = elements(prior, left[1]), b = elements(current, right[1]);
    for (let index = 0; ; index++) {
      const x = a.next(), y = b.next();
      if (x.done && y.done) return fact("none");
      if (x.done || y.done) return fact("message_count", index, null, x.done ? "missing" : "object", y.done ? "missing" : "object");
      if (samePart(prior, x.value, current, y.value)) continue;
      const m = fields(prior, x.value), n = fields(current, y.value);
      if (!m?.role || !n?.role || !m.content || !n.content) return fact("unavailable", index);
      if (!samePart(prior, m.role, current, n.role)) return fact("role", index, null, shape(prior, m.role), shape(current, n.role));
      const l = shape(prior, m.content), r = shape(current, n.content);
      if (l !== r) {
        const one = singleText(prior, m.content), two = singleText(current, n.content);
        return fact("content_shape", index, null, l, r, one && two ? samePart(prior, one, current, two) : null);
      }
      if (l === "string") return fact("text", index, null, l, r, false);
      if (l !== "array") return fact("other", index, null, l, r);
      const c = elements(prior, [m.content[0] + 1, m.content[1] - 1]), d = elements(current, [n.content[0] + 1, n.content[1] - 1]);
      for (let blockIndex = 0; ; blockIndex++) {
        const u = c.next(), v = d.next();
        if (u.done && v.done) return fact("other", index);
        if (u.done || v.done) return fact("block_count", index, blockIndex, u.done ? "missing" : "object", v.done ? "missing" : "object");
        if (samePart(prior, u.value, current, v.value)) continue;
        const p = fields(prior, u.value), q = fields(current, v.value);
        if (!p || !q) return fact("unavailable", index, blockIndex);
        for (const key of knownFields) {
          const x = p[key], y = q[key];
          if (!x && !y || x && y && samePart(prior, x, current, y)) continue;
          const sameText = key === "text" ? false : key === "citations" && p.text && q.text ? samePart(prior, p.text, current, q.text) : null;
          return fact(key, index, blockIndex, shape(prior, x), shape(current, y), sameText);
        }
        return fact("other", index, blockIndex);
      }
    }
  } catch (error) { return fact(error instanceof ComparisonLimit ? "limit" : "unavailable"); }
}
