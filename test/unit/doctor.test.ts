import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { homedir, tmpdir } from "node:os";
import { mkdtemp, mkdir, writeFile, rm, realpath } from "node:fs/promises";
import {
  probeSubswitch,
  probeTlsReachable,
  runDoctor,
  makeLiveListAgentFiles,
  PROVIDER_AUTH_INSPECTORS,
  type HttpGetResult,
  type TlsStatus,
  type DoctorIO,
} from "../../src/doctor.js";
import { loadConfig, type Config } from "../../src/config.js";
import { PROVIDER_IDS, type ProviderId, type RoutingTable } from "../../src/models.js";
import { checkAgentModels } from "../../src/agent-scan.js";

describe("probeSubswitch", () => {
  it("returns running when the health endpoint responds with the subswitch shape", async () => {
    const httpGet = async (): Promise<HttpGetResult> => ({
      ok: true,
      status: 200,
      body: JSON.stringify({ name: "subswitch", version: "0.1.0" }),
    });
    const result = await probeSubswitch(4141, { httpGet });
    assert.equal(result.kind, "running");
    if (result.kind === "running") {
      assert.equal(result.name, "subswitch");
      assert.equal(result.version, "0.1.0");
    }
  });

  it("returns connection_refused when nothing is listening on the port", async () => {
    const httpGet = async (): Promise<HttpGetResult> => ({ ok: false, connectionRefused: true });
    const result = await probeSubswitch(4141, { httpGet });
    assert.equal(result.kind, "connection_refused");
  });

  it("returns not_subswitch when a different service responds with a non-subswitch body", async () => {
    const httpGet = async (): Promise<HttpGetResult> => ({
      ok: true,
      status: 200,
      body: JSON.stringify({ name: "nginx", version: "1.0.0" }),
    });
    const result = await probeSubswitch(4141, { httpGet });
    assert.equal(result.kind, "not_subswitch");
  });

  it("returns not_subswitch when the response is non-200", async () => {
    const httpGet = async (): Promise<HttpGetResult> => ({
      ok: true,
      status: 404,
      body: "{}",
    });
    const result = await probeSubswitch(4141, { httpGet });
    assert.equal(result.kind, "not_subswitch");
  });

  it("returns not_subswitch when the response body is not JSON", async () => {
    const httpGet = async (): Promise<HttpGetResult> => ({
      ok: true,
      status: 200,
      body: "not json at all",
    });
    const result = await probeSubswitch(4141, { httpGet });
    assert.equal(result.kind, "not_subswitch");
  });

  it("returns not_subswitch on non-connection-refused network errors", async () => {
    const httpGet = async (): Promise<HttpGetResult> => ({
      ok: false,
      connectionRefused: false,
      message: "timeout",
    });
    const result = await probeSubswitch(4141, { httpGet });
    assert.equal(result.kind, "not_subswitch");
  });

  it("uses the correct URL based on the port argument", async () => {
    let capturedUrl = "";
    const httpGet = async (url: string): Promise<HttpGetResult> => {
      capturedUrl = url;
      return { ok: false, connectionRefused: true };
    };
    await probeSubswitch(9999, { httpGet });
    assert.equal(capturedUrl, "http://127.0.0.1:9999/__subswitch/health");
  });
});

describe("probeTlsReachable", () => {
  it("returns reachable when the TLS connect succeeds", async () => {
    const tlsConnect = async (): Promise<TlsStatus> => ({ kind: "reachable" });
    const result = await probeTlsReachable("api.anthropic.com", { tlsConnect });
    assert.equal(result.kind, "reachable");
  });

  it("returns unreachable when the TLS connect fails", async () => {
    const tlsConnect = async (): Promise<TlsStatus> => ({
      kind: "unreachable",
      message: "ECONNREFUSED",
    });
    const result = await probeTlsReachable("api.anthropic.com", { tlsConnect });
    assert.equal(result.kind, "unreachable");
    if (result.kind === "unreachable") {
      assert.equal(result.message, "ECONNREFUSED");
    }
  });

  it("passes the host and port 443 to the tlsConnect dep", async () => {
    let capturedHost = "";
    let capturedPort = 0;
    const tlsConnect = async (host: string, port: number): Promise<TlsStatus> => {
      capturedHost = host;
      capturedPort = port;
      return { kind: "reachable" };
    };
    await probeTlsReachable("chatgpt.com", { tlsConnect });
    assert.equal(capturedHost, "chatgpt.com");
    assert.equal(capturedPort, 443);
  });
});

// ---------------------------------------------------------------------------
// runDoctor — verdict line + exit code tests
// ---------------------------------------------------------------------------

/**
 * Returns a Config built from loadConfig with an empty file — identical to what
 * a user gets with no config options set.  Cannot drift from loadConfig's real
 * defaults because it IS loadConfig's real defaults.
 *
 * Pattern from test/unit/codex-handler.test.ts lines 104-106.
 */
const defaultConfig = (): Config => {
  const result = loadConfig({ configPath: "inline-test.json", readFile: () => "{}", env: {} });
  if (!result.ok) throw new Error(`loadConfig failed with empty config: ${result.error.message}`);
  return result.value.config;
};

// The defaultConfig — non-vacuity guard describe block was deleted (avoids PF-011,
// PF-012).  The guard compared defaultConfig() against the identical loadConfig()
// call that defaultConfig() IS — a tautology that cannot fail.  The real protection
// lives in test/unit/config.test.ts, which pins exact default values as literals.

const allPassIO = (lines: string[]) => ({
  write: (line: string) => lines.push(line),
  readAuthFile: async (): Promise<string> =>
    // Minimal valid auth JSON that inspectAuthFile will parse successfully.
    // AuthFileSchema expects { tokens: { access_token, refresh_token } }.
    JSON.stringify({
      tokens: {
        access_token: "eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ1c2VyMTIzIn0.sig",
        refresh_token: "ref",
      },
      auth_mode: "oauth",
    }),
  httpGet: async (): Promise<HttpGetResult> => ({
    ok: true,
    status: 200,
    body: JSON.stringify({ name: "subswitch", version: "0.1.0" }),
  }),
  tlsConnect: async (): Promise<TlsStatus> => ({ kind: "reachable" }),
  color: false,
  // No agent files by default — tests that need agent scan behaviour inject their own.
  listAgentFiles: async (): Promise<readonly string[]> => [],
  readTextFile: async (): Promise<string> => "",
});

const failingProbeIO = (lines: string[]) => ({
  ...allPassIO(lines),
  httpGet: async (): Promise<HttpGetResult> => ({ ok: false, connectionRefused: true }),
  tlsConnect: async (): Promise<TlsStatus> => ({ kind: "unreachable", message: "ECONNREFUSED" }),
  // ENOENT = unconfigured = informational; other errors = failure.
  // Use a non-ENOENT error so it still contributes a failure for these tests.
  readAuthFile: async (): Promise<string> => {
    const err = new Error("EACCES: permission denied") as Error & { code: string };
    err.code = "EACCES";
    throw err;
  },
});

const enoentAuthIO = (lines: string[]) => ({
  ...allPassIO(lines),
  readAuthFile: async (): Promise<string> => {
    // Simulate an ENOENT (unconfigured provider) — should NOT increment failures.
    const err = new Error("ENOENT: no such file") as Error & { code: string };
    err.code = "ENOENT";
    throw err;
  },
});

// ---------------------------------------------------------------------------
// Alias table and agent-scan tests
// ---------------------------------------------------------------------------

describe("runDoctor", () => {
  it("returns exit code 0 when all checks pass", async () => {
    const lines: string[] = [];
    const exitCode = await runDoctor(defaultConfig(), "/path/subswitch.config.json", true, allPassIO(lines));
    assert.equal(exitCode, 0);
  });

  it("includes a verdict line 'all checks passed' on success", async () => {
    const lines: string[] = [];
    await runDoctor(defaultConfig(), "/path/subswitch.config.json", true, allPassIO(lines));
    assert.ok(lines.some((l) => l.includes("all checks passed")), "must include all-pass verdict");
  });

  it("returns exit code 1 when a check fails (subswitch not running + TLS unreachable + auth permission error)", async () => {
    const lines: string[] = [];
    const exitCode = await runDoctor(defaultConfig(), "/path/subswitch.config.json", true, failingProbeIO(lines));
    assert.equal(exitCode, 1);
  });

  it("includes a failure verdict line showing problem count", async () => {
    const lines: string[] = [];
    await runDoctor(defaultConfig(), "/path/subswitch.config.json", true, failingProbeIO(lines));
    assert.ok(lines.some((l) => /\d+ problem/.test(l)), "must include problem count in verdict");
  });

  it("hints 'subswitch serve' when proxy is not running", async () => {
    const lines: string[] = [];
    await runDoctor(defaultConfig(), "/path/subswitch.config.json", true, {
      ...allPassIO(lines),
      httpGet: async (): Promise<HttpGetResult> => ({ ok: false, connectionRefused: true }),
    });
    assert.ok(lines.some((l) => l.includes("subswitch serve")), "must hint 'subswitch serve' when not running");
  });

  it("returns exit code 0 with no color codes when color=false", async () => {
    const lines: string[] = [];
    const exitCode = await runDoctor(defaultConfig(), "/path/subswitch.config.json", true, {
      ...allPassIO(lines),
      color: false,
    });
    assert.equal(exitCode, 0);
    for (const line of lines) {
      assert.ok(!line.includes("\x1b"), `line should not have ANSI codes: ${line}`);
    }
  });

  it("includes ANSI escape codes in the verdict line when color=true", async () => {
    const lines: string[] = [];
    const exitCode = await runDoctor(defaultConfig(), "/path/subswitch.config.json", true, {
      ...allPassIO(lines),
      color: true,
    });
    assert.equal(exitCode, 0);
    const verdictLine = lines.find((l) => l.includes("all checks passed"));
    assert.ok(verdictLine !== undefined, "must include all-pass verdict line");
    assert.ok(verdictLine.includes("\x1b"), "verdict line must contain ANSI escape code when color=true");
  });

  it("prints the alias table rows (one line per alias)", async () => {
    const lines: string[] = [];
    await runDoctor(defaultConfig(), "/path/subswitch.config.json", true, allPassIO(lines));
    // The alias table renders rows like: "sol  →  gpt-5.6-sol  codex  gen:5.6  enabled  (derived)"
    const tableLine = lines.find((l) => l.includes("sol") && l.includes("→") && l.includes("gpt-5.6-sol") && l.includes("gen:5.6"));
    assert.ok(tableLine !== undefined, "alias table must render a row: sol → gpt-5.6-sol gen:5.6 ...");
  });

  // PF-006: unconfigured provider (ENOENT auth file) must NOT increment failures.
  it("does NOT increment failures when provider auth file is absent (ENOENT = unconfigured = informational)", async () => {
    const lines: string[] = [];
    const exitCode = await runDoctor(defaultConfig(), "/path/subswitch.config.json", true, enoentAuthIO(lines));
    // Only subswitch probe + TLS checks remain; enoentAuthIO leaves those at pass.
    // So exit code must be 0 (no TLS failure, no subswitch failure, no auth failure).
    assert.equal(exitCode, 0, "ENOENT auth file must not cause failure — it is informational");
    const output = lines.join("\n");
    // Must not emit a FAIL row for auth.
    assert.ok(!output.includes("FAIL"), "ENOENT auth must not produce a FAIL row");
    // Must emit an informational message instead.
    assert.ok(output.includes("unconfigured"), "ENOENT auth must emit an 'unconfigured' informational message (PF-006)");
  });

  const unreadableAuthIO = (lines: string[]): DoctorIO => ({
    ...allPassIO(lines),
    readAuthFile: async (): Promise<string> => {
      const err = new Error("EACCES: permission denied") as Error & { code: string };
      err.code = "EACCES";
      throw err;
    },
  });

  // PF-006: severity depends on whether the user opted into the provider, not on
  // whether the registry happens to contain it.
  it("increments failures when an EXPLICITLY CONFIGURED provider's auth file is unreadable", async () => {
    const lines: string[] = [];
    const exitCode = await runDoctor(
      defaultConfig(),
      "/path/subswitch.config.json",
      true,
      unreadableAuthIO(lines),
      new Set<ProviderId>(["codex"]),
    );
    assert.equal(exitCode, 1, "a provider the user configured with a broken credential must fail");
    assert.ok(lines.join("\n").includes("UNAVAILABLE"), "must emit an UNAVAILABLE row");
  });

  it("does NOT increment failures when an UNCONFIGURED provider's auth file is unreadable", async () => {
    const lines: string[] = [];
    const exitCode = await runDoctor(
      defaultConfig(),
      "/path/subswitch.config.json",
      true,
      unreadableAuthIO(lines),
      new Set<ProviderId>(),
    );
    // A Codex-only user must not start failing the moment a second provider ships in
    // the registry and its default auth path happens to be unreadable. (avoids PF-006)
    assert.equal(exitCode, 0, "a provider the user never configured must stay informational");
    const output = lines.join("\n");
    assert.ok(!output.includes("FAIL"), "unconfigured provider must not produce a FAIL row");
    assert.ok(output.includes("unconfigured"), "unconfigured provider must emit an informational row");
  });

  it("fails on an auth file that exists but does not parse, regardless of opt-in", async () => {
    const lines: string[] = [];
    const exitCode = await runDoctor(
      defaultConfig(),
      "/path/subswitch.config.json",
      true,
      { ...allPassIO(lines), readAuthFile: async (): Promise<string> => "not json at all" },
      new Set<ProviderId>(),
    );
    // A credential file that is present but corrupt is always a real problem —
    // the user clearly has one, whatever the config file says.
    assert.equal(exitCode, 1, "a corrupt auth file must fail even when the provider is not in config");
  });

  it("writes provider rows in PROVIDER_IDS order regardless of I/O completion order", async () => {
    const lines: string[] = [];
    await runDoctor(
      defaultConfig(),
      "/path/subswitch.config.json",
      true,
      allPassIO(lines),
      new Set<ProviderId>(PROVIDER_IDS),
    );
    // Each provider's rows must be contiguous: no interleaving from concurrent checks.
    const output = lines.join("\n");
    for (const id of PROVIDER_IDS) {
      const authFileIdx = output.indexOf(`${id}.authFile:`);
      const modeIdx = output.indexOf(`${id} auth mode:`);
      assert.ok(authFileIdx >= 0 && modeIdx > authFileIdx, `${id} rows must be present and ordered`);
    }
  });
});

describe("runDoctor — agent model scan", () => {
  it("returns exit code 1 when an agent file has an unresolvable model", async () => {
    const lines: string[] = [];
    const exitCode = await runDoctor(defaultConfig(), "/path/subswitch.config.json", true, {
      ...allPassIO(lines),
      listAgentFiles: async () => ["/project/.claude/agents/bad-agent.md"],
      readTextFile: async () => "---\nmodel: totally-unknown-model\n---\n",
    });
    assert.equal(exitCode, 1, "unresolvable agent model should cause exit code 1");
  });

  it("emits a FAIL row for an unresolvable agent model", async () => {
    const lines: string[] = [];
    const agentFile = join(homedir(), ".claude", "agents", "bad-agent.md");
    await runDoctor(defaultConfig(), "/path/subswitch.config.json", true, {
      ...allPassIO(lines),
      listAgentFiles: async (dir: string): Promise<readonly string[]> => {
        return dir.includes(join(".claude", "agents")) ? [agentFile] : [];
      },
      readTextFile: async () => "---\nmodel: totally-unknown-model\n---\n",
    });
    const output = lines.join("\n");
    assert.ok(
      output.includes("totally-unknown-model"),
      "output must mention the problematic model name",
    );
    // A file discovered under both agent dirs must produce exactly ONE FAIL row.
    const failRows = lines.filter((l) => l.includes("totally-unknown-model"));
    assert.equal(failRows.length, 1, "a file discovered under both agent dirs must report once");
  });

  it("does not increment failures for an Anthropic tier name in agent frontmatter", async () => {
    const lines: string[] = [];
    const exitCode = await runDoctor(defaultConfig(), "/path/subswitch.config.json", true, {
      ...allPassIO(lines),
      listAgentFiles: async () => ["/project/.claude/agents/claude-main.md"],
      readTextFile: async () => "---\nmodel: sonnet\n---\n",
    });
    assert.equal(exitCode, 0, "Anthropic tier names should not cause failures");
  });

  it("does not fail when the agents directory is absent (listAgentFiles returns empty)", async () => {
    const lines: string[] = [];
    const exitCode = await runDoctor(defaultConfig(), "/path/subswitch.config.json", true, {
      ...allPassIO(lines),
      listAgentFiles: async () => [],
      readTextFile: async () => "",
    });
    assert.equal(exitCode, 0, "absent agents directory should not cause a failure");
  });

  it("labels only the first agent finding row with 'agent model:'; subsequent rows use a blank label", async () => {
    const lines: string[] = [];
    await runDoctor(defaultConfig(), "/path/subswitch.config.json", true, {
      ...allPassIO(lines),
      listAgentFiles: async () => [
        "/project/.claude/agents/bad-agent-1.md",
        "/project/.claude/agents/bad-agent-2.md",
      ],
      readTextFile: async (path): Promise<string> => {
        if (path.endsWith("bad-agent-1.md")) return "---\nmodel: unknown-model-alpha\n---\n";
        return "---\nmodel: unknown-model-beta\n---\n";
      },
    });
    const firstRow = lines.find((l) => l.includes("unknown-model-alpha"));
    const secondRow = lines.find((l) => l.includes("unknown-model-beta"));
    assert.ok(firstRow !== undefined, "first finding row must appear in output");
    assert.ok(secondRow !== undefined, "second finding row must appear in output");
    assert.ok(firstRow.includes("agent model:"), "first finding must carry the 'agent model:' label");
    assert.ok(!secondRow.includes("agent model:"), "subsequent findings must not repeat the 'agent model:' label");
  });

  it("does not increment failures for a provider_unconfigured finding (informational)", async () => {
    // When the auth file is absent (ENOENT), the provider is unconfigured.
    // Agent models that resolve to that provider produce provider_unconfigured (info, no failure).
    const lines: string[] = [];
    const exitCode = await runDoctor(defaultConfig(), "/path/subswitch.config.json", true, {
      ...enoentAuthIO(lines),
      listAgentFiles: async () => ["/project/.claude/agents/worker.md"],
      readTextFile: async () => "---\nmodel: gpt-5.6-sol\n---\n",
    });
    // codex is unconfigured → gpt-5.6-sol gets provider_unconfigured (info).
    // No other failures from enoentAuthIO + allPass TLS/subswitch.
    assert.equal(exitCode, 0, "provider_unconfigured finding must not cause failure");
  });

  // ---------------------------------------------------------------------------
  // unknown_provider severity — ADR-010: informational, not exit-1
  //
  // Non-vacuity requirement: the exit-0 test below is VACUOUS without a positive
  // control proving doctor CAN exit 1. That control is the existing
  // "returns exit code 1 when an agent file has an unresolvable model" test above —
  // it uses the same IO wiring and a different model to prove exit 1 is reachable.
  // Both tests together prove the distinction is real, not an accident of the harness.
  // ---------------------------------------------------------------------------

  it("unknown_provider finding alone does NOT cause exit code 1 (ADR-010: relay cannot honestly call this a failure)", async () => {
    // "kimi:k2-ultra" has an unknown_qualifier resolution — the prefix "kimi" is not in
    // PROVIDER_IDS. subswitch forwards it to Anthropic unchanged, so flagging it as a
    // failure would be a lie (ADR-010). The finding must be severity "info" → exit 0.
    //
    // Mutation that MUST turn this RED: change `severity: "info"` back to `severity: "fail"`
    // in the unknown_qualifier arm of checkAgentModels → exitCode becomes 1 → assertion fails.
    const lines: string[] = [];
    const exitCode = await runDoctor(defaultConfig(), "/path/subswitch.config.json", true, {
      ...allPassIO(lines),
      listAgentFiles: async () => ["/project/.claude/agents/exotic.md"],
      readTextFile: async () => "---\nmodel: kimi:k2-ultra\n---\n",
    });
    assert.equal(exitCode, 0, "unknown_provider finding must not cause exit code 1 — it is informational (ADR-010)");
  });

  it("unknown_provider finding renders with 'info' tag, not 'FAIL'", async () => {
    // Mutation that MUST turn this RED: change severity back to "fail" → doctor renders
    // FAIL (or whatever failStr emits) instead of "info" → the includes-check fails.
    const lines: string[] = [];
    await runDoctor(defaultConfig(), "/path/subswitch.config.json", true, {
      ...allPassIO(lines),
      listAgentFiles: async () => ["/project/.claude/agents/exotic.md"],
      readTextFile: async () => "---\nmodel: kimi:k2-ultra\n---\n",
    });
    const output = lines.join("\n");
    assert.ok(output.includes("kimi:k2-ultra"), "output must mention the model name");
    assert.ok(output.includes("kimi"), "output must mention the unknown qualifier");
    // Must NOT emit a FAIL row for unknown_provider (it is info).
    const findingLine = lines.find((l) => l.includes("kimi:k2-ultra"));
    assert.ok(findingLine !== undefined, "must have a line for the unknown_provider finding");
    assert.ok(
      !findingLine.includes("FAIL"),
      "unknown_provider finding line must not carry 'FAIL' — it is informational",
    );
  });

  // ---------------------------------------------------------------------------
  // ambiguous severity — must remain "fail" and produce exit 1
  //
  // runDoctor builds its routing table from the REAL MODEL_REGISTRY, which has no
  // ambiguous families (each family is unique to one provider). To exercise the
  // ambiguous → exit-1 path, we call checkAgentModels — the same function runDoctor
  // invokes — with a custom table that has an ambiguous family. This tests the
  // contract that doctor enforces: any finding whose severity is "fail" increments
  // failures, and failures > 0 → exit 1.
  //
  // Mutation that MUST turn this RED: change the `ambiguous` arm in src/agent-scan.ts
  // from `severity: "fail"` to `severity: "info"` → finding.severity becomes "info"
  // → the assert.equal("fail") assertion fails.
  // ---------------------------------------------------------------------------

  it("ambiguous finding has severity 'fail', which causes doctor exit code 1", () => {
    const ambiguousTable: RoutingTable = {
      byId: new Map([["gpt-5.6-sol", "codex"] as const]),
      byFamily: new Map([["sol", { kind: "ambiguous", providers: ["codex", "codex"] as readonly ["codex", "codex"] }]]),
      byQualified: new Map(),
      byAlias: new Map(),
    };
    const files = [{ path: "/agent.md", text: "---\nmodel: sol\n---\n" }];
    const findings = checkAgentModels(files, ambiguousTable, new Set());
    assert.equal(findings.length, 1);
    assert.equal(findings[0]!.kind, "ambiguous");
    assert.equal(
      findings[0]!.severity,
      "fail",
      "ambiguous finding must remain severity 'fail' — doctor increments failures++ for each 'fail' finding, which produces exit 1",
    );
    // Verify the exit-1 contract directly: doctor exits 1 iff failures > 0,
    // and failures increments for every finding with severity "fail".
    const wouldFailures = findings.filter((f) => f.severity === "fail").length;
    assert.equal(wouldFailures, 1, "ambiguous finding must contribute exactly one failure increment → exit 1");
  });
});

// ---------------------------------------------------------------------------
// PROVIDER_AUTH_INSPECTORS — totality anchor (ARCH-01)
// ---------------------------------------------------------------------------
// Mutation-proof control: removing a key from PROVIDER_AUTH_INSPECTORS is a
// compile error (Record<ProviderId, …> requires all keys). This runtime test
// additionally proves the harness can reach each entry — i.e. that the record
// is not a Partial accidentally cast to Readonly<Record<…>>. (avoids PF-011)
//
describe("PROVIDER_AUTH_INSPECTORS", () => {
  it("has an inspector function for every ProviderId", () => {
    for (const id of PROVIDER_IDS) {
      assert.equal(
        typeof PROVIDER_AUTH_INSPECTORS[id],
        "function",
        `PROVIDER_AUTH_INSPECTORS must have an inspector function for provider "${id}"`,
      );
    }
  });
});

// ---------------------------------------------------------------------------
// credentialUsable → providersWithCredentials (CPLX-03 regression)
// ---------------------------------------------------------------------------
// Mutation-proof control: if credentialUsable is stuck at false, every resolved
// codex model would produce a provider_unconfigured finding. (avoids PF-011)
//
describe("runDoctor — credentialUsable drives providersWithCredentials", () => {
  it("a provider with a valid auth file is in providersWithCredentials — its agent models are not flagged as provider_unconfigured", async () => {
    const lines: string[] = [];
    // allPassIO returns a valid auth file → credentialUsable=true → codex in providersWithCredentials.
    // gpt-5.6-sol resolves to codex; with codex in the set there must be no provider_unconfigured row.
    const exitCode = await runDoctor(defaultConfig(), "/path/subswitch.config.json", true, {
      ...allPassIO(lines),
      listAgentFiles: async () => ["/project/.claude/agents/worker.md"],
      readTextFile: async () => "---\nmodel: gpt-5.6-sol\n---\n",
    });
    assert.equal(exitCode, 0, "a provider with valid credentials must not trigger provider_unconfigured");
    const output = lines.join("\n");
    assert.ok(
      !output.includes("not configured"),
      "a provider whose auth file is valid must not produce a 'not configured' finding",
    );
  });
});

// ---------------------------------------------------------------------------
// makeLiveListAgentFiles — factory-level absolute path resolution (item 1 guard)
// ---------------------------------------------------------------------------

describe("makeLiveListAgentFiles — absolute path deduplication", () => {
  it("resolves both a relative and the matching absolute path to the same absolute entry so Set deduplication fires", async () => {
    // Canonicalize before chdir: on macOS /var is a symlink to /private/var, so
    // mkdtemp returns /var/folders/... but process.cwd() returns /private/var/folders/...
    // after chdir.  Resolving the symlink up front ensures both strings match.
    const tmpDirRaw = await mkdtemp(join(tmpdir(), "croxy-doctor-factory-test-"));
    const tmpDir = await realpath(tmpDirRaw);
    const originalCwd = process.cwd();
    try {
      process.chdir(tmpDir);
      // Create .claude/agents/test.md under tmpDir (which is now cwd).
      await mkdir(join(tmpDir, ".claude", "agents"), { recursive: true });
      await writeFile(join(tmpDir, ".claude", "agents", "test.md"), "---\nmodel: test\n---\n", "utf8");

      const listAgentFiles = makeLiveListAgentFiles();
      // Relative path — points at cwd/.claude/agents (cwd === canonical tmpDir)
      const relPath = join(".", ".claude", "agents");
      // Absolute path — the same physical directory, now also canonical
      const absPath = join(tmpDir, ".claude", "agents");

      const relResult = await listAgentFiles(relPath);
      const absResult = await listAgentFiles(absPath);

      assert.ok(relResult.length > 0, "relative path must return at least one file");
      assert.ok(absResult.length > 0, "absolute path must return at least one file");

      // Both calls must return identical absolute path strings for the same file.
      const combined = new Set([...relResult, ...absResult]);
      assert.equal(
        combined.size,
        1,
        `both relative and absolute paths for the same directory must yield identical absolute paths so the Set collapses them to one entry; got: ${JSON.stringify([...combined])}`,
      );
    } finally {
      process.chdir(originalCwd);
      await rm(tmpDirRaw, { recursive: true, force: true });
    }
  });
});
