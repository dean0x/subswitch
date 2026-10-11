import type { ClassifiedFailure } from "./routing-types.js";

/** Carries classification intact until route selection finishes. */
export class AttemptFailure extends Error {
  constructor(readonly failure: ClassifiedFailure) {
    super(failure.kind);
  }
  get clientCode(): string {
    return `route_${this.failure.kind}`;
  }
  get clientStatus(): number {
    const status = this.failure.status;
    return status !== undefined &&
      Number.isInteger(status) &&
      status >= 400 &&
      status <= 599
      ? status
      : 502;
  }
}
