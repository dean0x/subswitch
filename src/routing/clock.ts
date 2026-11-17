/** Shared routed-provider bounds: ten minutes total and five minutes without data. */
export const ROUTING_TOTAL_TIMEOUT_MS = 600_000;
export const ROUTING_IDLE_TIMEOUT_MS = 300_000;

export interface RoutingClock {
  now(): number;
  monotonic(): number;
  random(): number;
  schedule?:
    | ((callback: () => void, delayMs: number) => () => void)
    | undefined;
}
export const systemClock: RoutingClock = {
  now: Date.now,
  monotonic: () => performance.now(),
  random: Math.random,
};
export const scheduleRoutingTimer = (
  clock: RoutingClock,
  callback: () => void,
  delayMs: number,
): (() => void) => {
  if (clock.schedule) return clock.schedule(callback, delayMs);
  const timer = setTimeout(callback, delayMs).unref();
  return () => clearTimeout(timer);
};
