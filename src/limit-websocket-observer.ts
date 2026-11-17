import type { Logger } from "./logger.js";
import { BoundedCapture } from "./bounded-capture.js";
import {
  LIMIT_CAPTURE_BYTES,
  recordLimitEvent,
  type LimitContext,
} from "./limit-observation.js";

/** Passive server-frame inspection. It never owns or changes the native WS tunnel. */
export class LimitWebSocketObserver {
  private header = Buffer.alloc(0);
  private remaining = 0;
  private final = false;
  private collecting = false;
  private activeText = false;
  private dropped = false;
  private readonly capture = new BoundedCapture(LIMIT_CAPTURE_BYTES);
  private disabled = false;
  private warned = false;
  constructor(
    private readonly logger: Logger,
    private readonly context: LimitContext,
  ) {}
  write(chunk: Buffer): void {
    if (!this.logger.recordLimit || this.disabled) return;
    let offset = 0;
    while (offset < chunk.length) {
      if (!this.remaining) {
        const desired =
          this.header.length < 2
            ? 2
            : (this.header[1]! & 127) === 126
              ? 4
              : (this.header[1]! & 127) === 127
                ? 10
                : 2;
        const count = Math.min(
          desired - this.header.length,
          chunk.length - offset,
        );
        if (count) {
          this.header = Buffer.concat([
            this.header,
            chunk.subarray(offset, offset + count),
          ]);
          offset += count;
        }
        if (this.header.length < desired || this.header.length < 2) continue;
        const lengthCode = this.header[1]! & 127;
        if (
          (lengthCode === 126 && this.header.length < 4) ||
          (lengthCode === 127 && this.header.length < 10)
        )
          continue;
        if (this.header[1]! & 128) {
          this.gap("masked_server_frame");
          this.disabled = true;
          return;
        }
        const length =
          lengthCode < 126
            ? BigInt(lengthCode)
            : lengthCode === 126
              ? BigInt(this.header.readUInt16BE(2))
              : this.header.readBigUInt64BE(2);
        if (length > BigInt(Number.MAX_SAFE_INTEGER)) {
          this.gap("oversized_frame");
          this.disabled = true;
          return;
        }
        this.remaining = Number(length);
        this.final = !!(this.header[0]! & 128);
        const opcode = this.header[0]! & 15;
        if (opcode === 1) {
          this.activeText = true;
          this.capture.reset();
          this.dropped = false;
          if (this.header[0]! & 64) {
            this.dropped = true;
            this.gap("compressed_native_websocket");
          }
        }
        this.collecting = opcode === 1 || (opcode === 0 && this.activeText);
        this.header = Buffer.alloc(0);
        if (!this.remaining) {
          this.finishFrame();
          continue;
        }
      }
      const count = Math.min(this.remaining, chunk.length - offset);
      if (this.collecting && !this.dropped) {
        if (!this.capture.append(chunk.subarray(offset, offset + count))) {
          this.dropped = true;
          this.capture.reset();
        }
      }
      this.remaining -= count;
      offset += count;
      if (!this.remaining) this.finishFrame();
    }
  }
  private finishFrame(): void {
    if (!this.collecting || !this.final) return;
    if (!this.dropped) {
      try {
        recordLimitEvent(
          this.logger,
          this.context,
          JSON.parse(this.capture.bytes.toString("utf8")),
          "websocket",
        );
      } catch {
        /* Invalid native payload is forwarded unchanged. */
      }
    } else this.gap("native_websocket_capture_limit");
    this.capture.reset();
    this.activeText = false;
    this.collecting = false;
  }
  private gap(code: string): void {
    if (this.warned) return;
    this.warned = true;
    try {
      this.logger.log("warn", "limit_observation_partial", { errorCode: code });
    } catch {
      /* Never affect the tunnel. */
    }
  }
}
