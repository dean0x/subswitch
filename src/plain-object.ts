/**
 * Guard for plain (non-array, non-null) objects.
 *
 * Used by doctor.ts (health-check body parsing) and init.ts (JSON merge logic).
 * src/config.ts keeps its own intentionally separate copy — that one is a
 * prototype-pollution boundary whose isolation must not be weakened.
 */
export const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
