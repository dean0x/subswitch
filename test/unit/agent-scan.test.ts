import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseFrontmatterModel, checkAgentModels } from "../../src/agent-scan.js";

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
  // Routable set covering all known canonical ids
  const fullRoutable = new Set(["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna", "gpt-5.5"]);
  const noOverrides: Record<string, string> = {};

  it("returns empty findings when all files have no frontmatter model", () => {
    const files = [
      { path: "/a.md", text: "# Just markdown" },
      { path: "/b.md", text: "---\nname: agent\n---\nNo model key." },
    ];
    const findings = checkAgentModels(files, fullRoutable, noOverrides);
    assert.equal(findings.length, 0);
  });

  it("returns an unresolvable finding when the model is not a known id or alias", () => {
    const files = [
      { path: "/agent.md", text: "---\nmodel: my-unknown-model\n---\n" },
    ];
    const findings = checkAgentModels(files, fullRoutable, noOverrides);
    assert.equal(findings.length, 1);
    assert.equal(findings[0]!.kind, "unresolvable");
    assert.equal(findings[0]!.model, "my-unknown-model");
    assert.equal(findings[0]!.file, "/agent.md");
  });

  it("returns no finding when the model is a known family alias (e.g. sol)", () => {
    const files = [
      { path: "/agent.md", text: "---\nmodel: sol\n---\n" },
    ];
    const findings = checkAgentModels(files, fullRoutable, noOverrides);
    assert.equal(findings.length, 0, "known alias should produce no finding");
  });

  it("returns no finding when the model is a canonical id present in codex.models", () => {
    const files = [
      { path: "/agent.md", text: "---\nmodel: gpt-5.5\n---\n" },
    ];
    const findings = checkAgentModels(files, fullRoutable, noOverrides);
    assert.equal(findings.length, 0);
  });

  it("returns an excluded finding when the model resolves but is not in narrowed codex.models", () => {
    const narrowed = new Set(["gpt-5.5"]); // only gpt-5.5, no sol-family models
    const files = [
      { path: "/agent.md", text: "---\nmodel: gpt-5.6-sol\n---\n" },
    ];
    const findings = checkAgentModels(files, narrowed, noOverrides);
    assert.equal(findings.length, 1);
    assert.equal(findings[0]!.kind, "excluded");
    assert.equal(findings[0]!.model, "gpt-5.6-sol");
    assert.equal(findings[0]!.canonical, "gpt-5.6-sol");
  });

  it("produces no finding for Anthropic tier name 'sonnet'", () => {
    const files = [
      { path: "/main.md", text: "---\nmodel: sonnet\n---\n" },
    ];
    const findings = checkAgentModels(files, fullRoutable, noOverrides);
    assert.equal(findings.length, 0, "sonnet should be silently skipped");
  });

  it("produces no finding for Anthropic tier name 'opus'", () => {
    const files = [
      { path: "/main.md", text: "---\nmodel: opus\n---\n" },
    ];
    const findings = checkAgentModels(files, fullRoutable, noOverrides);
    assert.equal(findings.length, 0, "opus should be silently skipped");
  });

  it("produces no finding for Anthropic tier name 'haiku'", () => {
    const files = [
      { path: "/main.md", text: "---\nmodel: haiku\n---\n" },
    ];
    const findings = checkAgentModels(files, fullRoutable, noOverrides);
    assert.equal(findings.length, 0, "haiku should be silently skipped");
  });

  it("produces no finding for 'inherit' sentinel", () => {
    const files = [
      { path: "/agent.md", text: "---\nmodel: inherit\n---\n" },
    ];
    const findings = checkAgentModels(files, fullRoutable, noOverrides);
    assert.equal(findings.length, 0, "inherit should be silently skipped");
  });

  it("produces no finding for a claude-* model id", () => {
    const files = [
      { path: "/agent.md", text: "---\nmodel: claude-3-7-sonnet-20250219\n---\n" },
    ];
    const findings = checkAgentModels(files, fullRoutable, noOverrides);
    assert.equal(findings.length, 0, "claude-* models should be silently skipped");
  });

  it("'excluded' finding is not a failure — it is informational only", () => {
    // Verify that excluded findings have kind === "excluded", not "unresolvable".
    // The doctor counts only "unresolvable" as failures.
    const narrowed = new Set(["gpt-5.5"]);
    const files = [
      { path: "/agent.md", text: "---\nmodel: gpt-5.6-sol\n---\n" },
    ];
    const findings = checkAgentModels(files, narrowed, noOverrides);
    assert.equal(findings.length, 1);
    assert.equal(findings[0]!.kind, "excluded");
  });

  it("returns no finding when a custom model id is directly in codex.models", () => {
    // Custom id (not in registry) but present in codex.models → exact membership wins.
    const customRoutable = new Set(["gpt-5.5", "my-custom-id"]);
    const files = [
      { path: "/agent.md", text: "---\nmodel: my-custom-id\n---\n" },
    ];
    const findings = checkAgentModels(files, customRoutable, noOverrides);
    assert.equal(findings.length, 0, "exact id in codex.models must route fine");
  });

  it("handles multiple files and returns a finding per problematic file", () => {
    const files = [
      { path: "/good.md", text: "---\nmodel: gpt-5.6-sol\n---\n" },
      { path: "/bad.md", text: "---\nmodel: totally-unknown\n---\n" },
      { path: "/also-bad.md", text: "---\nmodel: another-unknown\n---\n" },
    ];
    const findings = checkAgentModels(files, fullRoutable, noOverrides);
    assert.equal(findings.length, 2);
    assert.ok(findings.some((f) => f.file === "/bad.md"), "bad.md should produce a finding");
    assert.ok(findings.some((f) => f.file === "/also-bad.md"), "also-bad.md should produce a finding");
  });
});
