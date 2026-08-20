import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseFrontmatterModel, checkAgentModels } from "../../src/agent-scan.js";
import {
  MODEL_REGISTRY,
  buildRoutingTable,
  type RoutingTable,
  type ModelEntry,
} from "../../src/models.js";

// ---------------------------------------------------------------------------
// parseFrontmatterModel — frontmatter parsing
// ---------------------------------------------------------------------------

describe("parseFrontmatterModel", () => {
  it("returns the model value from a well-formed frontmatter block", () => {
    const text = "---\nname: gpt-worker\nmodel: gpt-5.6-sol\n---\nBody text here.";
    assert.equal(parseFrontmatterModel(text), "gpt-5.6-sol");
  });

  it("returns undefined when the opening delimiter is absent", () => {
    const text = "name: gpt-worker\nmodel: gpt-5.6-sol\n---\nBody.";
    assert.equal(parseFrontmatterModel(text), undefined);
  });

  it("returns undefined when the model key is absent", () => {
    const text = "---\nname: gpt-worker\ndescription: A worker agent\n---\nBody.";
    assert.equal(parseFrontmatterModel(text), undefined);
  });

  it("ignores a model: key that appears after the closing delimiter", () => {
    const text = "---\nname: agent\n---\nmodel: gpt-5.6-sol";
    assert.equal(parseFrontmatterModel(text), undefined);
  });

  it("strips double quotes from a quoted value", () => {
    const text = '---\nmodel: "gpt-5.6-sol"\n---\n';
    assert.equal(parseFrontmatterModel(text), "gpt-5.6-sol");
  });

  it("strips single quotes from a quoted value", () => {
    const text = "---\nmodel: 'gpt-5.6-sol'\n---\n";
    assert.equal(parseFrontmatterModel(text), "gpt-5.6-sol");
  });

  it("strips trailing # comment from the model value", () => {
    const text = "---\nmodel: sol # alias — always the latest generation\n---\n";
    assert.equal(parseFrontmatterModel(text), "sol");
  });

  it("strips a trailing comment that follows a quoted value", () => {
    const text = '---\nmodel: "gpt-5.6-sol" # the fast one\n---\n';
    assert.equal(parseFrontmatterModel(text), "gpt-5.6-sol");
  });

  it("keeps a # that is INSIDE quotes — it is part of the value, not a comment", () => {
    // Stripping the comment before resolving quotes truncated this to `"sol`, which
    // doctor then reported as unresolvable — failing the exit code on a valid file.
    const text = '---\nmodel: "sol # not-a-comment"\n---\n';
    assert.equal(parseFrontmatterModel(text), "sol # not-a-comment");
  });

  it("does not emit a stray quote when a quoted value is unterminated", () => {
    const text = '---\nmodel: "gpt-5.6-sol\n---\n';
    assert.equal(parseFrontmatterModel(text), "gpt-5.6-sol");
  });

  it("handles CRLF line endings", () => {
    const text = "---\r\nname: gpt-worker\r\nmodel: gpt-5.6-luna\r\n---\r\n";
    assert.equal(parseFrontmatterModel(text), "gpt-5.6-luna");
  });

  it("does NOT match modelPreference: (prefix collision guard)", () => {
    const text = "---\nmodelPreference: something\n---\n";
    assert.equal(parseFrontmatterModel(text), undefined);
  });

  it("enforces byte cap on a pathological file with no closing delimiter", () => {
    // 8 KiB + extra content; the extra content past the cap must not cause issues.
    const padding = "x".repeat(8 * 1024 + 100);
    const text = `---\nname: agent\n${padding}`;
    // Should return undefined — no model key found within the cap.
    assert.equal(parseFrontmatterModel(text), undefined);
  });

  it("never returns a partially-truncated value when the cap lands mid-line", () => {
    // A long `description:` can push `model:` across the 8 KiB boundary. If the trailing
    // partial line were kept, the parser would return e.g. "gpt-5.6-s" and doctor would
    // report a healthy agent file as having an unresolvable model.
    for (let pad = 8 * 1024 - 60; pad < 8 * 1024 + 5; pad++) {
      const text = `---\ndescription: ${"d".repeat(pad)}\nmodel: gpt-5.6-sol\n---\n`;
      const parsed = parseFrontmatterModel(text);
      assert.ok(
        parsed === undefined || parsed === "gpt-5.6-sol",
        `pad=${pad} produced a truncated value: ${JSON.stringify(parsed)}`,
      );
    }
  });

  it("still reads a model that sits just inside the cap", () => {
    const text = `---\ndescription: ${"d".repeat(4000)}\nmodel: gpt-5.6-sol\n---\n`;
    assert.equal(parseFrontmatterModel(text), "gpt-5.6-sol");
  });

  it("enforces line cap on a frontmatter block with very many keys", () => {
    // 201 keys before model: — exceeds the 200-line cap.
    const manyKeys = Array.from({ length: 201 }, (_, i) => `key${i}: val`).join("\n");
    const text = `---\n${manyKeys}\nmodel: gpt-5.6-sol\n---\n`;
    // model: appears past line 200, so it must be ignored.
    assert.equal(parseFrontmatterModel(text), undefined);
  });
});

// ---------------------------------------------------------------------------
// checkAgentModels — model routing analysis
// ---------------------------------------------------------------------------

describe("checkAgentModels", () => {
  // Build a routing table from the real registry with no overrides.
  const { table } = buildRoutingTable(MODEL_REGISTRY, { codex: {} });
  // All providers configured by default.
  const configuredProviders = new Set<string>(["codex"]);
  const noConfiguredProviders = new Set<string>();

  it("returns empty findings when all files have no frontmatter model", () => {
    const files = [
      { path: "/a.md", text: "# Just markdown" },
      { path: "/b.md", text: "---\nname: agent\n---\nNo model key." },
    ];
    const findings = checkAgentModels(files, table, configuredProviders);
    assert.equal(findings.length, 0);
  });

  // ------------------------------------------------------------------
  // Failing kinds (increment doctor failures)
  // ------------------------------------------------------------------

  it("returns 'unresolvable' finding when the model is not known at all", () => {
    const files = [{ path: "/agent.md", text: "---\nmodel: my-unknown-model\n---\n" }];
    const findings = checkAgentModels(files, table, configuredProviders);
    assert.equal(findings.length, 1);
    assert.equal(findings[0]!.kind, "unresolvable");
    assert.equal(findings[0]!.severity, "fail", "unresolvable finding must have severity 'fail' (drives doctor exit 1)");
    assert.equal(findings[0]!.model, "my-unknown-model");
    assert.equal(findings[0]!.file, "/agent.md");
  });

  it("returns 'ambiguous' finding when a family name is claimed by multiple providers", () => {
    // Construct a minimal RoutingTable manually to simulate an ambiguous family.
    const ambiguousTable: RoutingTable = {
      byId: new Map([["gpt-5.6-sol", "codex"] as const]),
      byFamily: new Map([["sol", { kind: "ambiguous", providers: ["codex", "codex"] as readonly ["codex", "codex"] }]]),
      byQualified: new Map(),
      byAlias: new Map(),
    };
    const files = [{ path: "/agent.md", text: "---\nmodel: sol\n---\n" }];
    const findings = checkAgentModels(files, ambiguousTable, configuredProviders);
    assert.equal(findings.length, 1);
    assert.equal(findings[0]!.kind, "ambiguous");
    assert.equal(findings[0]!.severity, "fail", "ambiguous finding must have severity 'fail' — must not be demoted to 'info' (ambiguous is a subswitch-derived routing conflict, not an informational note)");
    assert.ok(Array.isArray(findings[0]!.providers), "ambiguous finding must include providers list");
  });

  it("returns 'unknown_provider' finding when the model uses an unrecognised provider prefix", () => {
    // Non-vacuity: this test would fail if kind were changed to any other value, and the
    // severity assertion below ensures the test fails if severity is changed back to "fail".
    const files = [{ path: "/agent.md", text: "---\nmodel: kimi:k2-ultra\n---\n" }];
    const findings = checkAgentModels(files, table, configuredProviders);
    assert.equal(findings.length, 1);
    assert.equal(findings[0]!.kind, "unknown_provider");
    assert.equal(findings[0]!.qualifier, "kimi");
    // ADR-010: an unknown qualifier forwards to Anthropic and works — this is informational,
    // not a failure. By contrast "ambiguous" stays "fail" because that is subswitch-derived.
    assert.equal(
      findings[0]!.severity,
      "info",
      "unknown_provider must be severity 'info' (ADR-010); changing it back to 'fail' breaks exit-code contract",
    );
  });

  // ------------------------------------------------------------------
  // Informational kinds (do NOT increment doctor failures)
  // ------------------------------------------------------------------

  it("returns 'retired' finding when the model resolves to a retired registry entry", () => {
    const reg: readonly ModelEntry[] = [
      { id: "gpt-5.6-sol", provider: "codex", family: "sol", gen: [5, 6] },
      { id: "gpt-retired", provider: "codex", gen: [5, 0], retired: true },
    ];
    const { table: regTable } = buildRoutingTable(reg, { codex: {} });
    const files = [{ path: "/agent.md", text: "---\nmodel: gpt-retired\n---\n" }];
    const findings = checkAgentModels(files, regTable, configuredProviders, reg);
    assert.equal(findings.length, 1);
    assert.equal(findings[0]!.kind, "retired");
    assert.equal(findings[0]!.canonical, "gpt-retired");
  });

  it("returns 'provider_unconfigured' finding when the provider is not in configuredProviders", () => {
    const files = [{ path: "/agent.md", text: "---\nmodel: gpt-5.6-sol\n---\n" }];
    const findings = checkAgentModels(files, table, noConfiguredProviders);
    assert.equal(findings.length, 1);
    assert.equal(findings[0]!.kind, "provider_unconfigured");
    assert.equal(findings[0]!.canonical, "gpt-5.6-sol");
  });

  it("returns 'preview_only' finding when the model resolves to a preview registry entry", () => {
    const reg: readonly ModelEntry[] = [
      { id: "gpt-5.6-sol", provider: "codex", family: "sol", gen: [5, 6] },
      { id: "gpt-preview", provider: "codex", gen: [5, 7], preview: true },
    ];
    const { table: regTable } = buildRoutingTable(reg, { codex: {} });
    const files = [{ path: "/agent.md", text: "---\nmodel: gpt-preview\n---\n" }];
    const findings = checkAgentModels(files, regTable, configuredProviders, reg);
    assert.equal(findings.length, 1);
    assert.equal(findings[0]!.kind, "preview_only");
    assert.equal(findings[0]!.canonical, "gpt-preview");
  });

  // ------------------------------------------------------------------
  // Anthropic skip list (must produce no findings)
  // ------------------------------------------------------------------

  it("produces no finding for Anthropic tier name 'sonnet'", () => {
    const files = [{ path: "/main.md", text: "---\nmodel: sonnet\n---\n" }];
    const findings = checkAgentModels(files, table, configuredProviders);
    assert.equal(findings.length, 0, "sonnet should be silently skipped");
  });

  it("produces no finding for Anthropic tier name 'opus'", () => {
    const files = [{ path: "/main.md", text: "---\nmodel: opus\n---\n" }];
    const findings = checkAgentModels(files, table, configuredProviders);
    assert.equal(findings.length, 0, "opus should be silently skipped");
  });

  it("produces no finding for Anthropic tier name 'haiku'", () => {
    const files = [{ path: "/main.md", text: "---\nmodel: haiku\n---\n" }];
    const findings = checkAgentModels(files, table, configuredProviders);
    assert.equal(findings.length, 0, "haiku should be silently skipped");
  });

  it("produces no finding for 'inherit' sentinel", () => {
    const files = [{ path: "/agent.md", text: "---\nmodel: inherit\n---\n" }];
    const findings = checkAgentModels(files, table, configuredProviders);
    assert.equal(findings.length, 0, "inherit should be silently skipped");
  });

  it("produces no finding for a claude-* model id", () => {
    const files = [{ path: "/agent.md", text: "---\nmodel: claude-3-7-sonnet-20250219\n---\n" }];
    const findings = checkAgentModels(files, table, configuredProviders);
    assert.equal(findings.length, 0, "claude-* models should be silently skipped");
  });

  it("produces no finding for Anthropic tier names carrying a variant suffix", () => {
    for (const model of ["sonnet[1m]", "opusplan", "haiku-3-5", "Claude-Sonnet-4-5"]) {
      const findings = checkAgentModels(
        [{ path: "/main.md", text: `---\nmodel: ${model}\n---\n` }],
        table,
        configuredProviders,
      );
      assert.equal(findings.length, 0, `${model} should be silently skipped`);
    }
  });

  // ------------------------------------------------------------------
  // Happy-path resolution (no finding)
  // ------------------------------------------------------------------

  it("returns no finding when the model is a known family alias (e.g. sol)", () => {
    const files = [{ path: "/agent.md", text: "---\nmodel: sol\n---\n" }];
    const findings = checkAgentModels(files, table, configuredProviders);
    assert.equal(findings.length, 0, "known alias should produce no finding");
  });

  it("returns no finding when the model is a canonical id in the registry", () => {
    const files = [{ path: "/agent.md", text: "---\nmodel: gpt-5.5\n---\n" }];
    const findings = checkAgentModels(files, table, configuredProviders);
    assert.equal(findings.length, 0);
  });

  // ------------------------------------------------------------------
  // Multi-file and informational-vs-failure classification
  // ------------------------------------------------------------------

  it("handles multiple files and returns a finding per problematic file", () => {
    const files = [
      { path: "/good.md", text: "---\nmodel: gpt-5.6-sol\n---\n" },
      { path: "/bad.md", text: "---\nmodel: totally-unknown\n---\n" },
      { path: "/also-bad.md", text: "---\nmodel: another-unknown\n---\n" },
    ];
    const findings = checkAgentModels(files, table, configuredProviders);
    assert.equal(findings.length, 2);
    assert.ok(findings.some((f) => f.file === "/bad.md"), "bad.md should produce a finding");
    assert.ok(findings.some((f) => f.file === "/also-bad.md"), "also-bad.md should produce a finding");
  });

  it("'retired', 'provider_unconfigured', 'preview_only' and 'unknown_provider' findings are informational (severity is 'info')", () => {
    // Derive the failing/passing distinction from finding.severity — the single source of
    // truth — rather than re-stating which kinds fail in a hand-written Set (which was
    // exactly the duplicated source of truth eliminated by AgentFindingBase's doc comment).
    //
    // Every kind the title names is exercised. The earlier version asserted only
    // provider_unconfigured, so promoting `retired` or `preview_only` to "fail" — which
    // would make `doctor` exit 1 for any agent pinned to a retired or preview model, a
    // PF-006 CI break — passed with the test name still claiming to cover them.
    //
    // Non-vacuity: assert.equal(severity, "info") is RED for any kind promoted to "fail";
    // verified per kind.

    const cases: { readonly label: string; readonly findings: ReturnType<typeof checkAgentModels> }[] = [];

    // provider_unconfigured
    cases.push({
      label: "provider_unconfigured",
      findings: checkAgentModels(
        [{ path: "/agent.md", text: "---\nmodel: gpt-5.6-sol\n---\n" }],
        table,
        noConfiguredProviders,
      ),
    });

    // retired
    const retiredReg: readonly ModelEntry[] = [
      { id: "gpt-5.6-sol", provider: "codex", family: "sol", gen: [5, 6] },
      { id: "gpt-retired", provider: "codex", gen: [5, 0], retired: true },
    ];
    cases.push({
      label: "retired",
      findings: checkAgentModels(
        [{ path: "/agent.md", text: "---\nmodel: gpt-retired\n---\n" }],
        buildRoutingTable(retiredReg, { codex: {} }).table,
        configuredProviders,
        retiredReg,
      ),
    });

    // preview_only
    const previewReg: readonly ModelEntry[] = [
      { id: "gpt-5.6-sol", provider: "codex", family: "sol", gen: [5, 6] },
      { id: "gpt-preview", provider: "codex", gen: [5, 7], preview: true },
    ];
    cases.push({
      label: "preview_only",
      findings: checkAgentModels(
        [{ path: "/agent.md", text: "---\nmodel: gpt-preview\n---\n" }],
        buildRoutingTable(previewReg, { codex: {} }).table,
        configuredProviders,
        previewReg,
      ),
    });

    // unknown_provider — flipped from "fail" to "info" (ADR-010): subswitch forwards the
    // request to Anthropic unchanged, so the qualifier never blocks anything.
    cases.push({
      label: "unknown_provider",
      findings: checkAgentModels(
        [{ path: "/agent.md", text: "---\nmodel: kimee:k2\n---\n" }],
        table,
        configuredProviders,
      ),
    });

    for (const { label, findings } of cases) {
      assert.equal(findings.length, 1, `${label}: expected exactly one finding`);
      assert.equal(findings[0]!.kind, label, `${label}: finding kind must match the case under test`);
      assert.equal(
        findings[0]!.severity,
        "info",
        `${label} must be severity 'info' — a 'fail' here makes doctor exit 1 and breaks CI smoke scripts (PF-006); got: ${findings[0]!.severity}`,
      );
    }
  });
});
