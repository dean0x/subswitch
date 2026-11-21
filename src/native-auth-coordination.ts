import { realpathSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import type { ProviderId } from "./models.js";

/** Resolve the physical persistence target, retaining directory aliases for a new file. */
export function nativeAuthFilePath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    const absolute = resolve(path);
    try {
      return join(realpathSync(dirname(absolute)), basename(absolute));
    } catch {
      return absolute;
    }
  }
}

interface RefreshFlight {
  owner: string;
  promise: Promise<unknown>;
}
const flights = new Map<string, RefreshFlight>();
const idleWaiters = new Set<() => void>();

/** Wait until all tracked renewals complete, or until the shutdown bound expires. */
export function settleNativeRefreshes(timeoutMs: number): Promise<void> {
  if (flights.size === 0) return Promise.resolve();
  return new Promise((resolve) => {
    const finish = (): void => {
      clearTimeout(timer);
      idleWaiters.delete(finish);
      resolve();
    };
    const timer = setTimeout(finish, timeoutMs);
    idleWaiters.add(finish);
  });
}

/**
 * Share refresh and persistence only for the same native store and credential lineage.
 * A replacement owner queues behind the old operation instead of receiving its result.
 * Callers retain their own cancellation/deadline; one waiter cannot cancel another.
 */
export function coordinateNativeRefresh<T>(
  provider: ProviderId | "claude",
  storage: string | undefined,
  owner: string,
  operation: () => Promise<T>,
): Promise<T> {
  if (storage === undefined) return operation();
  const key = JSON.stringify([provider, storage]);
  const previous = flights.get(key);
  // A store contains one provider's credential contract, so identical owner flights
  // also have an identical result contract. No manager instance or credential is pooled.
  if (previous?.owner === owner) return previous.promise as Promise<T>;
  const ready = previous
    ? previous.promise.then(
        () => undefined,
        () => undefined,
      )
    : Promise.resolve();
  const flight: RefreshFlight = { owner, promise: Promise.resolve() };
  const promise = ready.then(operation).finally(() => {
    if (flights.get(key) !== flight) return;
    flights.delete(key);
    if (flights.size === 0) idleWaiters.forEach((finish) => finish());
  });
  flight.promise = promise;
  flights.set(key, flight);
  return promise;
}
