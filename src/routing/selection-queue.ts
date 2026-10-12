import { abortable } from "../abortable.js";

/** Serializes affinity selection per action/agent/route, including cancelled waiters. */
export class SelectionQueue {
  private readonly tails = new Map<string, Promise<void>>();

  async acquire(key: string, signal: AbortSignal): Promise<() => void> {
    signal.throwIfAborted();
    const previous = this.tails.get(key);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const current = (previous ?? Promise.resolve()).then(() => gate);
    this.tails.set(key, current);
    // A cancelled waiter retains its place until its predecessor releases.
    void current.then(() => {
      if (this.tails.get(key) === current) this.tails.delete(key);
    });
    try {
      if (previous) await abortable(previous, signal);
      signal.throwIfAborted();
      return release;
    } catch (error) {
      release();
      throw error;
    }
  }
}
