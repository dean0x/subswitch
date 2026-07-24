/**
 * Resolve whether colour output should be enabled.
 *
 * Precedence (highest to lowest):
 *   1. FORCE_COLOR is set to a non-empty value that is not "0" → true
 *   2. NO_COLOR key is present in env (presence semantics — value irrelevant) → false
 *   3. isTTY
 *
 * This is the single source of truth for color-enable logic; import it in
 * logger.ts (stderr TTY) and cli.ts (stdout TTY for doctor).
 */
export const resolveColorEnabled = (
  env: Record<string, string | undefined>,
  isTTY: boolean,
): boolean => {
  const forceColor = env["FORCE_COLOR"];
  if (forceColor !== undefined && forceColor !== "" && forceColor !== "0") return true;
  if ("NO_COLOR" in env) return false;
  return isTTY;
};
