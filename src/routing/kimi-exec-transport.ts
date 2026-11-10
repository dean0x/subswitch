/** Pull-only SSE framing for the disabled exec path. No listeners or record queue. */
import type { SseEvent } from "../codex-response.js";
import { abortable } from "../abortable.js";
import { KimiExecPending, type KimiExecReservation } from "./kimi-exec-pending.js";
import { RoutingError } from "./routing-types.js";

const maxFrameBytes = 4 * 1024 * 1024;

function parseFrame(raw: string, pending: KimiExecPending): SseEvent {
  if (Buffer.byteLength(raw) > maxFrameBytes) throw new RoutingError("sse_event_too_large", 502);
  const lines = raw.split(/\r?\n/), linesLease = pending.retain(lines);
  const data: string[] = [], dataLeases: KimiExecReservation[] = [];
  try {
    let event: string | undefined;
    for (const line of lines) {
      if (line.startsWith("data:")) {
        const part = line.slice(5).replace(/^ /, "");
        const lease = pending.retain([part]);
        data.push(part); dataLeases.push(lease);
      }
      else if (line.startsWith("event:")) event = line.slice(6).replace(/^ /, "");
    }
    return data.length ? { event, data: data.join("\n") } : { event: "__subswitch_comment", data: raw };
  } finally {
    lines.length = 0;
    data.length = 0;
    for (const lease of dataLeases) lease.release();
    dataLeases.length = 0;
    linesLease.release();
  }
}

/**
 * Charges received bytes, decoded segments, materialized framing and each parked
 * SSE record against the SAME owner as lifecycle/projection. Pulls one chunk at a
 * time and yields one record at a time; never enqueues an entire chunk of records.
 * Fetch's own unread network buffers are outside Subswitch's retained ownership.
 */
export async function* kimiExecTransport(
  body: ReadableStream<Uint8Array>,
  pending: KimiExecPending,
  signal: AbortSignal,
  onBytes: () => void,
  onSourceError: (error: unknown) => void,
): AsyncGenerator<SseEvent> {
  // At most3 undecoded UTF8 bytes +3 delimiter carry characters (including escaping).
  const fixed = pending.reserve(32), parts: string[] = [], leases: KimiExecReservation[] = [];
  let reader: ReadableStreamDefaultReader<Uint8Array>;
  try { reader = body.getReader(); } catch (error) { fixed.release(); throw error; }
  const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }), separator = /\r?\n\r?\n/g;
  let carry = "", partBytes = 0;
  const clearParts = () => {
    parts.length = 0;
    for (const lease of leases) lease.release();
    leases.length = 0;
    partBytes = 0;
  };
  const append = (text: string) => {
    if (!text) return;
    partBytes += Buffer.byteLength(text);
    // A delimiter may straddle chunks; reserve room for its unfinished prefix.
    if (partBytes > maxFrameBytes + 3) throw new RoutingError("sse_event_too_large", 502);
    const lease = pending.retain([text]);
    parts.push(text);
    leases.push(lease);
  };
  try {
    while (true) {
      signal.throwIfAborted();
      let chunk: Awaited<ReturnType<typeof reader.read>> | undefined;
      try { chunk = await abortable(reader.read(), signal); }
      catch (error) { onSourceError(error); throw error; }
      const done = chunk.done;
      let chunkLease: KimiExecReservation | undefined, textLease: KimiExecReservation | undefined;
      let searchLease: KimiExecReservation | undefined, bufferLease: KimiExecReservation | undefined;
      let text: string | undefined, search: string | undefined, buffer: string | undefined;
      try {
        if (!done) { chunkLease = pending.reserve(chunk.value.byteLength); onBytes(); }
        try { text = done ? decoder.decode() : decoder.decode(chunk.value, { stream: true }); }
        catch { throw new RoutingError("invalid_provider_utf8", 502); }
        chunk = undefined;
        chunkLease?.release(); chunkLease = undefined;
        textLease = pending.retain(text);
        search = carry + text;
        searchLease = pending.retain(search);
        separator.lastIndex = 0;
        let match = separator.exec(search);
        if (!match && !done) {
          append(text);
          carry = search.slice(-3);
          continue;
        }
        const scanStart = parts.reduce((n, part) => n + part.length, 0) - carry.length;
        buffer = parts.join("") + text;
        bufferLease = pending.retain(buffer);
        clearParts();
        carry = "";
        text = undefined; textLease.release(); textLease = undefined;
        let offset = 0, boundary = match ? scanStart + match.index : -1;
        let width = match?.[0].length ?? 0;
        match = null; // RegExp match.input otherwise retains the complete search across yield.
        search = undefined; searchLease.release(); searchLease = undefined;
        while (boundary !== -1 || done) {
          signal.throwIfAborted();
          let raw: string | undefined = buffer.slice(offset, boundary === -1 ? undefined : boundary);
          let rawLease: KimiExecReservation | undefined, eventLease: KimiExecReservation | undefined;
          let event: SseEvent | undefined;
          try {
            rawLease = pending.retain(raw);
            event = parseFrame(raw, pending);
            eventLease = pending.retain(event);
            yield event;
            signal.throwIfAborted(); // Includes resuming a parked EOF tail before normal completion.
          } finally {
            event = undefined; raw = undefined;
            eventLease?.release(); rawLease?.release();
          }
          if (boundary === -1) break;
          offset = boundary + width;
          separator.lastIndex = offset;
          const next = separator.exec(buffer);
          boundary = next?.index ?? -1;
          width = next?.[0].length ?? 0;
        }
        if (done) break;
        const residual = buffer.slice(offset);
        append(residual);
        carry = residual.slice(-3);
      } finally {
        chunk = undefined; text = undefined; search = undefined; buffer = undefined;
        chunkLease?.release(); textLease?.release(); searchLease?.release(); bufferLease?.release();
      }
    }
  } finally {
    clearParts(); carry = "";
    // Match the existing attempt's finite cancellation cleanup; do not hang on a
    // transport whose cancel promise does not settle after abort or iterator return.
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([reader.cancel().catch(() => {}), new Promise<void>(resolve => { timer = setTimeout(resolve, 100); })]);
    } finally {
      clearTimeout(timer);
      reader.releaseLock();
      fixed.release();
    }
  }
}
