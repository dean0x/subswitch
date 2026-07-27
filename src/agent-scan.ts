// Agent frontmatter scanner for the doctor preflight check.
// No external dependencies — a parser for one `model:` line does not warrant one.

import { MODEL_REGISTRY, isReservedAnthropicName, type RoutingTable, type ModelEntry, resolveModel } from "./models.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AgentFinding {
  /** Path to the agent file that produced the finding. */
  readonly file: string;
  /** Model value exactly as written in the frontmatter. */
  readonly model: string;
  /**
   * Finding severity and meaning:
   *
   * Failures (increment doctor failures):
   * - "unresolvable": not a known id, alias, or family in the routing table.
   * - "ambiguous": family name claimed by multiple providers — must qualify with provider:name.
   * - "unknown_provider": looks like "provider:id" but the prefix is not in PROVIDER_IDS.
   *
   * Informational (no failure increment):
   * - "retired": resolves to a known canonical that is marked retired in the registry.
   * - "provider_unconfigured": resolves to a known canonical but the provider lacks credentials.
   * - "preview_only": resolves to a preview model — excluded from family alias derivation.
   */
  readonly kind: "unresolvable" | "ambiguous" | "unknown_provider" | "retired" | "provider_unconfigured" | "preview_only";
  /** Populated when the model resolves to a canonical id (retired, provider_unconfigured, preview_only). */
  readonly canonical?: string;
  /** Populated for "ambiguous" — providers that claim the name. */
  readonly providers?: readonly string[];
  /** Populated for "unknown_provider" — the unrecognised prefix. */
  readonly qualifier?: string;
}

// ---------------------------------------------------------------------------
// Frontmatter parser (no YAML dependency)
// ---------------------------------------------------------------------------

/**
 * Cap the scanned prefix, matching doctor.ts's 8 KiB bounded-read discipline. [F49]
 * Counted in UTF-16 code units (String.slice), which is <= the byte length for any
 * input, so the effective read stays inside the 8 KiB budget.
 */
const MAX_SCAN_CHARS = 8 * 1024;
/** Line cap prevents pathological files with no closing delimiter. [reliability] */
const MAX_SCAN_LINES = 200;

/**
 * Extract the `model:` value from a YAML frontmatter block.
 *
 * Rules:
 * - Text must begin with `---` on the first line.
 * - Scan lines until the closing `---` delimiter (cap: MAX_SCAN_LINES / MAX_SCAN_CHARS).
 * - Match `^model:\s*(.+)$` within the frontmatter only.
 * - `modelPreference:` and other `model`-prefixed keys are NOT matched.
 * - Strip surrounding single/double quotes.
 * - Strip trailing `# comment`.
 * - Handle CRLF line endings.
 * - Returns undefined if the delimiter is absent, the key is absent, or the value is empty.
 */
export const parseFrontmatterModel = (text: string): string | undefined => {
  // Cap at MAX_SCAN_CHARS before splitting so pathological inputs don't blow memory.
  const capped = text.slice(0, MAX_SCAN_CHARS);
  // Normalise line endings.
  const lines = capped.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");

  // The cap can land mid-line. Drop that trailing partial line, otherwise a `model:`
  // straddling the boundary yields a truncated value ("gpt-5.6-s") that doctor then
  // reports as an unresolvable model — a diagnostic failing on a file that is fine.
  if (capped.length < text.length) lines.pop();

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
// Model checker
// ---------------------------------------------------------------------------

/**
 * Check agent files for model routing problems and return findings.
 *
 * Each element of `files` is a `{ path, text }` pair — path is logged in
 * findings; text is the raw file content (already read by the caller).
 *
 * @param files              Agent file path + text pairs to inspect.
 * @param table              Pre-built routing table (built once at startup by doctor).
 * @param configuredProviders Set of provider ids that have credentials available.
 * @param registry           Model registry — injectable for testing retired/preview kinds.
 *
 * Finding kinds (in resolution order):
 * - unresolvable  (fail): resolveModel returns "unresolved".
 * - ambiguous     (fail): resolveModel returns "ambiguous".
 * - unknown_provider (fail): resolveModel returns "unknown_qualifier".
 * - retired       (info): resolves to a registry entry marked retired.
 * - provider_unconfigured (info): resolves ok but provider is not in configuredProviders.
 * - preview_only  (info): resolves to a registry entry marked preview.
 */
export const checkAgentModels = (
  files: ReadonlyArray<{ readonly path: string; readonly text: string }>,
  table: RoutingTable,
  configuredProviders: ReadonlySet<string>,
  registry: readonly ModelEntry[] = MODEL_REGISTRY,
): readonly AgentFinding[] => {
  const findings: AgentFinding[] = [];

  for (const { path, text } of files) {
    const model = parseFrontmatterModel(text);
    if (model === undefined) continue;

    // Skip Anthropic-leg names — they are valid and route to Anthropic, not Codex.
    // Without this skip doctor would fail on every repo that has Claude subagents.
    if (isReservedAnthropicName(model)) continue;

    const resolution = resolveModel(table, model);

    switch (resolution.kind) {
      case "unresolved":
        findings.push({ file: path, model, kind: "unresolvable" });
        break;

      case "ambiguous":
        findings.push({ file: path, model, kind: "ambiguous", providers: resolution.providers });
        break;

      case "unknown_qualifier":
        findings.push({ file: path, model, kind: "unknown_provider", qualifier: resolution.qualifier });
        break;

      case "resolved": {
        const { target } = resolution;
        const entry = registry.find((e) => e.id === target.id);

        if (entry?.retired === true) {
          findings.push({ file: path, model, kind: "retired", canonical: target.id });
          break;
        }

        if (!configuredProviders.has(target.provider)) {
          findings.push({ file: path, model, kind: "provider_unconfigured", canonical: target.id });
          break;
        }

        if (entry?.preview === true) {
          findings.push({ file: path, model, kind: "preview_only", canonical: target.id });
          break;
        }

        // Resolves fine, provider configured, not retired, not preview → no finding.
        break;
      }

      default: {
        // Exhaustive guard — compiler enforces that all ModelResolution arms are handled.
        const _exhaustive: never = resolution;
        void _exhaustive;
      }
    }
  }

  return findings;
};
