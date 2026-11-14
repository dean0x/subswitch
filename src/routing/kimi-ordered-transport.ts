/** Pull-only framing for the selected ordered codec; never activates experimental exec. */
import { StringDecoder } from "node:string_decoder";
import { parseSseRecord, type SseEvent } from "../codex-response.js";
import { abortable } from "../abortable.js";
import { jsonStringBytes } from "../json-size.js";
import type { KimiExecPending, KimiExecReservation } from "./kimi-exec-pending.js";
import { RoutingError } from "./routing-types.js";

const maxFrameBytes = 4 * 1024 * 1024;

// StringDecoder replaces malformed UTF8. Each non-ASCII input byte needs at most
// three output bytes; ASCII escaping is exact. Includes its three-byte carry.
function decodedBound(bytes: Uint8Array): number {
  let size = 20;
  for (const n of bytes) size += n === 34 || n === 92 || n === 8 || n === 9 || n === 10 || n === 12 || n === 13
    ? 2 : n < 32 ? 6 : n < 128 ? 1 : 3;
  return size;
}

export async function* kimiOrderedTransport(
  body: ReadableStream<Uint8Array>, pending: KimiExecPending, signal: AbortSignal,
  onBytes: () => void, onSourceError: (error: unknown) => void,
): AsyncGenerator<SseEvent> {
  // Decoder carry, delimiter carry and empty segment-array framing.
  const fixed = pending.reserve(64);
  let reader: ReadableStreamDefaultReader<Uint8Array>;
  try { reader = body.getReader(); } catch (error) { fixed.release(); throw error; }
  const decoder = new StringDecoder("utf8"), separator = /\r?\n\r?\n/g;
  const parts: string[] = [], leases: KimiExecReservation[] = [];
  let carry = "", partLength = 0, partEscaped = 0;
  const clearParts = () => {
    parts.length = 0; partLength = 0; partEscaped = 0;
    for (const lease of leases) lease.release();
    leases.length = 0;
  };
  const append = (text: string) => {
    if (!text) return;
    // Preserve the ordinary parser's residual UTF16 limit and completed byte limit.
    if (partLength + text.length > maxFrameBytes + 3) throw new RoutingError("sse_event_too_large", 502);
    const bytes = jsonStringBytes(text), lease = pending.reserve(bytes + 1);
    parts.push(text); leases.push(lease); partLength += text.length; partEscaped += bytes - 2;
  };
  try {
    while (true) {
      signal.throwIfAborted();
      let chunk: Awaited<ReturnType<typeof reader.read>> | undefined;
      try { chunk = await abortable(reader.read(), signal); }
      catch (error) { onSourceError(error); throw error; }
      const done = chunk.done;
      let chunkLease: KimiExecReservation | undefined, textLease: KimiExecReservation | undefined;
      let searchLease: KimiExecReservation | undefined, joinedLease: KimiExecReservation | undefined;
      let bufferLease: KimiExecReservation | undefined;
      let text: string | undefined, search: string | undefined, joined: string | undefined, buffer: string | undefined;
      try {
        if (!done) { chunkLease = pending.reserve(chunk.value.byteLength); onBytes(); }
        textLease = pending.reserve(done ? 20 : decodedBound(chunk.value));
        text = done ? decoder.end() : decoder.write(chunk.value);
        chunk = undefined; chunkLease?.release(); chunkLease = undefined;
        searchLease = pending.reserve(jsonStringBytes(carry) + jsonStringBytes(text));
        search = carry + text;
        separator.lastIndex = 0;
        let match = separator.exec(search);
        if (!match && !done) {
          append(text); carry = search.slice(-3);
          if (partLength > maxFrameBytes) throw new RoutingError("sse_event_too_large", 502);
          continue;
        }
        const scanStart = partLength - carry.length;
        joinedLease = pending.reserve(partEscaped + 2);
        joined = parts.join("");
        bufferLease = pending.reserve(partEscaped + jsonStringBytes(text));
        buffer = joined + text;
        joined = undefined; joinedLease.release(); joinedLease = undefined;
        clearParts(); carry = "";
        text = undefined; textLease.release(); textLease = undefined;
        let offset = 0, boundary = match ? scanStart + match.index : -1, width = match?.[0].length ?? 0;
        match = null; search = undefined; searchLease.release(); searchLease = undefined;
        while (boundary !== -1 || done) {
          signal.throwIfAborted();
          const end = boundary === -1 ? buffer.length : boundary;
          const rawBytes = jsonStringBytes(buffer, offset, end);
          let raw: string | undefined, event: SseEvent | undefined;
          let rawLease: KimiExecReservation | undefined, parseLease: KimiExecReservation | undefined;
          let eventLease: KimiExecReservation | undefined;
          try {
            rawLease = pending.reserve(rawBytes);
            raw = buffer.slice(offset, end);
            if (Buffer.byteLength(raw) > maxFrameBytes) throw new RoutingError("sse_event_too_large", 502);
            let lines = 1;
            for (let i = 0; i < raw.length; i++) if (raw.charCodeAt(i) === 10) lines++;
            // split lines, slice/replace parts, data array and join overlap. Each
            // line may add quotes/separators; reserve BEFORE entering the grammar.
            parseLease = pending.reserve(4 * rawBytes + 8 * lines + 64);
            eventLease = pending.reserve(rawBytes + 64);
            event = parseSseRecord(raw, true)!;
            parseLease.release(); parseLease = undefined;
            yield event;
            signal.throwIfAborted();
          } finally {
            raw = undefined; event = undefined;
            parseLease?.release(); eventLease?.release(); rawLease?.release();
          }
          if (boundary === -1) break;
          offset = boundary + width;
          separator.lastIndex = offset;
          const next = separator.exec(buffer);
          boundary = next?.index ?? -1; width = next?.[0].length ?? 0;
        }
        if (done) break;
        const residualLease = pending.reserve(jsonStringBytes(buffer, offset));
        let residual: string | undefined;
        try { residual = buffer.slice(offset); append(residual); carry = residual.slice(-3); }
        finally { residual = undefined; residualLease.release(); }
        if (partLength > maxFrameBytes) throw new RoutingError("sse_event_too_large", 502);
      } finally {
        chunk = undefined; text = undefined; search = undefined; joined = undefined; buffer = undefined;
        chunkLease?.release(); textLease?.release(); searchLease?.release(); joinedLease?.release(); bufferLease?.release();
      }
    }
  } finally {
    clearParts(); carry = "";
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([reader.cancel().catch(() => {}), new Promise<void>(resolve => { timer = setTimeout(resolve, 100); })]);
    } finally { clearTimeout(timer); reader.releaseLock(); fixed.release(); }
  }
}
