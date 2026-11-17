/** Reusable byte capture whose memory bound is independent of chunk fragmentation. */
export class BoundedCapture {
  private buffer = Buffer.alloc(0);
  private length = 0;

  constructor(private readonly maxBytes: number) {}

  append(chunk: Buffer): boolean {
    const length = this.length + chunk.length;
    if (length > this.maxBytes) return false;
    if (length > this.buffer.length) {
      const capacity = Math.min(
        this.maxBytes,
        Math.max(length, this.buffer.length * 2, 1024),
      );
      const grown = Buffer.allocUnsafe(capacity);
      this.buffer.copy(grown, 0, 0, this.length);
      this.buffer = grown;
    }
    chunk.copy(this.buffer, this.length);
    this.length = length;
    return true;
  }

  /** Only captured bytes are exposed; unused capacity is never read. */
  get bytes(): Buffer {
    return this.buffer.subarray(0, this.length);
  }

  reset(): void {
    this.length = 0;
  }
}
