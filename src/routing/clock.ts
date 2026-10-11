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
