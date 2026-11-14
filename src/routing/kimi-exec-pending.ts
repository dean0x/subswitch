/** One serialized pending-state allowance per disabled exec attempt, shareable across layers. */
import { RoutingError } from "./routing-types.js";
import { jsonBytes } from "../json-size.js";

export interface KimiExecReservation {
  release(): void;
}

export class KimiExecPending {
  private bytes = 0;
  readonly limit = 32 * 1024 * 1024;
  get byteSize(): number { return this.bytes; }

  /** Reserve before retaining a representation. No reset/transfer-to-a-new-allowance operation. */
  reserve(bytes: number): KimiExecReservation {
    if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > this.limit - this.bytes)
      throw new RoutingError("provider_state_too_large", 502);
    this.bytes += bytes;
    let retained = true;
    return { release: () => {
      if (retained) { retained = false; this.bytes -= bytes; }
    } };
  }
  retain(value: unknown): KimiExecReservation {
    return this.reserve(this.measure(value) + 1);
  }
  measure(value: unknown): number {
    try { return jsonBytes(value, this.limit); }
    catch (error) {
      if (error instanceof RangeError) throw new RoutingError("provider_state_too_large", 502);
      throw error;
    }
  }
  /** The temporary serialization has its own lease, separate from retained data. */
  serializedBytes(value: unknown): number {
    // Encoding the JSON text as a string can escape every byte once more.
    const lease = this.reserve(2 * this.measure(value) + 3);
    let encoded: string | undefined;
    try { encoded = JSON.stringify(value); return Buffer.byteLength(encoded); }
    finally { encoded = undefined; lease.release(); }
  }
}
