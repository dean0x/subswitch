// Agent frontmatter scanner for the doctor preflight check.
// No external dependencies — a parser for one `model:` line does not warrant one.

import { makeModelResolver, MODEL_REGISTRY, ALL_MODEL_IDS } from "./models.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AgentFinding {
  /** Path to the agent file that produced the finding. */
  readonly file: string;
  /** Model value exactly as written in the frontmatter. */
  readonly model: string;
  /**
   * - "unresolvable": the model string is not a known canonical id, alias, or family —
   *   it will silently 404 on the Codex leg. Increments doctor failures.
   * - "excluded": the model resolves to a known canonical but that canonical is not
   *   in the configured codex.models list — routing is informational (not a failure)
   *   because the proxy will pass through to Anthropic, which may or may not know it.
   */
  readonly kind: "unresolvable" | "excluded";
  /** Populated for "excluded" — the canonical id the model string would resolve to. */
  readonly canonical?: string;
}

// ---------------------------------------------------------------------------
// Frontmatter parser (no YAML dependency)
// ---------------------------------------------------------------------------

/** Cap reads to match doctor.ts's MAX_BODY_BYTES discipline. [F49] */
const MAX_SCAN_BYTES = 8 * 1024;
/** Line cap prevents pathological files with no closing delimiter. [reliability] */
const MAX_SCAN_LINES = 200;

/**
 * Extract the `model:` value from a YAML frontmatter block.
 *
 * Rules:
 * - Text must begin with `---` on the first line.
 * - Scan lines until the closing `---` delimiter (cap: MAX_SCAN_LINES / MAX_SCAN_BYTES).
 * - Match `^model:\s*(.+)$` within the frontmatter only.
 * - `modelPreference:` and other `model`-prefixed keys are NOT matched.
 * - Strip surrounding single/double quotes.
 * - Strip trailing `# comment`.
 * - Handle CRLF line endings.
 * - Returns undefined if the delimiter is absent, the key is absent, or the value is empty.
 */
export const parseFrontmatterModel = (text: string): string | undefined => {
  // Cap at MAX_SCAN_BYTES before splitting so pathological inputs don't blow memory.
  const capped = text.slice(0, MAX_SCAN_BYTES);
  // Normalise line endings.
  const lines = capped.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");

  // First line must be the opening delimiter.
  if (lines[0]?.trimEnd() !== "---") return undefined;

  for (let i = 1; i < Math.min(lines.length, MAX_SCAN_LINES); i++) {
    const line = lines[i] ?? "";

    // Closing delimiter ends the frontmatter — stop scanning.
    if (line.trimEnd() === "---") return undefined; // no model found before close

    // Match `model:` key (exact — `modelPreference:` does NOT match).
    const match = /^model:\s*(.+)$/.exec(line);
    if (match !== null) {
      let value = match[1]!.trim();
      // Strip trailing comment.
      const commentIdx = value.indexOf(" #");
      if (commentIdx >= 0) value = value.slice(0, commentIdx).trimEnd();
      // Strip surrounding quotes (single or double).
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      return value.length > 0 ? value : undefined;
    }
  }

  return undefined;
};

// ---------------------------------------------------------------------------
// Skip list — valid Claude Code / Anthropic tier names
// ---------------------------------------------------------------------------

/**
 * Pattern for model names that are valid Claude Code / Anthropic values and
 * should never produce a doctor finding. Without this skip, doctor would
 * erroneously fail on every repo that has non-Codex agent files.
 *
 * - `inherit`: Claude Code's "inherit parent model" sentinel.
 * - `sonnet`, `opus`, `haiku`: Claude tier short-names.
 * - `claude-*`: Any Claude model id (e.g. claude-3-7-sonnet-20250219).
 *
 * Match is case-insensitive to handle casing variations. [PF-006 boundary]
 */
const ANTHROPIC_SKIP_RE = /^(inherit|sonnet|opus|haiku|claude-)/i;

// ---------------------------------------------------------------------------
// Model checker
// ---------------------------------------------------------------------------

/**
 * Check agent files for model routing problems and return findings.
 *
 * Each element of `files` is a `{ path, text }` pair — path is logged in
 * findings; text is the raw file content (already read by the caller).
 *
 * Resolution uses two resolvers:
 * - `routeResolver`: scoped to the actual `codex.models` set — returns non-null
 *   when the model will route successfully through the proxy.
 * - `fullResolver`: scoped to all known model ids — returns non-null when the
 *   model is recognized at all, regardless of whether it's in codex.models.
 *
 * Finding kinds:
 * - "unresolvable": routeResolver and fullResolver both return undefined —
 *   the model string is entirely unknown. Increments failures.
 * - "excluded": fullResolver resolves but routeResolver does not —
 *   the model is known but not in the narrowed codex.models. Informational only.
 */
export const checkAgentModels = (
  files: ReadonlyArray<{ readonly path: string; readonly text: string }>,
  routable: ReadonlySet<string>,
  overrides: Record<string, string>,
): readonly AgentFinding[] => {
  // Two resolvers: one against all known ids, one against the actual routable set.
  const allKnownSet = new Set(ALL_MODEL_IDS);
  const fullResolver = makeModelResolver(MODEL_REGISTRY, allKnownSet, overrides);
  const routeResolver = makeModelResolver(MODEL_REGISTRY, routable, overrides);

  const findings: AgentFinding[] = [];

  for (const { path, text } of files) {
    const model = parseFrontmatterModel(text);
    if (model === undefined) continue;

    // Skip Anthropic-tier names — they are valid and route to Anthropic, not Codex.
    if (ANTHROPIC_SKIP_RE.test(model)) continue;

    // Check routing first: if it routes successfully, no finding.
    const routed = routeResolver(model);
    if (routed !== undefined) continue;

    // Doesn't route — check if it's known at all.
    const canonical = fullResolver(model);
    if (canonical === undefined) {
      // Truly unknown — will silently 404 on the Codex leg.
      findings.push({ file: path, model, kind: "unresolvable" });
    } else {
      // Known canonical but excluded from the narrowed codex.models list.
      // Informational only — matches doctor's own precedent for missing config. [F53]
      findings.push({ file: path, model, kind: "excluded", canonical });
    }
  }

  return findings;
};
