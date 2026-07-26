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
  type HttpGetResult,
  type TlsStatus,
} from "../../src/doctor.js";
import type { Config } from "../../src/config.js";

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

/** Minimal valid config for testing */
const makeTestConfig = (): Config => ({
  port: 4141,
  logLevel: "info",
  anthropic: { baseUrl: "https://api.anthropic.com" },
  codex: {
    baseUrl: "https://chatgpt.com/backend-api/codex",
    oauthTokenUrl: "https://auth.openai.com/oauth/token",
    authFile: "/home/user/.codex/auth.json",
    models: ["gpt-5.6-sol", "gpt-5.5"],
    userAgent: "codex_cli_rs/0.144.6",
    aliases: {},
  },
  reasoningCache: { maxEntries: 4096, maxBytes: 64 * 1024 * 1024 },
  limits: {
    maxBodyBytes: 32 * 1024 * 1024,
    connectTimeoutMs: 10_000,
    streamIdleTimeoutMs: 300_000,
    requestTimeoutMs: 600_000,
    pingIntervalMs: 15_000,
    maxSseEventBytes: 4 * 1024 * 1024,
    maxUpstreamSockets: 32,
  },
});

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
  readAuthFile: async (): Promise<string> => {
    throw new Error("ENOENT");
  },
});

// ---------------------------------------------------------------------------
// Alias table and agent-scan tests
// ---------------------------------------------------------------------------

describe("runDoctor", () => {
  it("returns exit code 0 when all checks pass", async () => {
    const lines: string[] = [];
    const exitCode = await runDoctor(makeTestConfig(), "/path/subswitch.config.json", true, allPassIO(lines));
    assert.equal(exitCode, 0);
  });

  it("includes a verdict line 'all checks passed' on success", async () => {
    const lines: string[] = [];
    await runDoctor(makeTestConfig(), "/path/subswitch.config.json", true, allPassIO(lines));
    assert.ok(lines.some((l) => l.includes("all checks passed")), "must include all-pass verdict");
  });

  it("returns exit code 1 when a check fails (subswitch not running + TLS unreachable + auth unavailable)", async () => {
    const lines: string[] = [];
    const exitCode = await runDoctor(makeTestConfig(), "/path/subswitch.config.json", true, failingProbeIO(lines));
    assert.equal(exitCode, 1);
  });

  it("includes a failure verdict line showing problem count", async () => {
    const lines: string[] = [];
    await runDoctor(makeTestConfig(), "/path/subswitch.config.json", true, failingProbeIO(lines));
    assert.ok(lines.some((l) => /\d+ problem/.test(l)), "must include problem count in verdict");
  });

  it("hints 'subswitch serve' when proxy is not running", async () => {
    const lines: string[] = [];
    await runDoctor(makeTestConfig(), "/path/subswitch.config.json", true, {
      ...allPassIO(lines),
      httpGet: async (): Promise<HttpGetResult> => ({ ok: false, connectionRefused: true }),
    });
    assert.ok(lines.some((l) => l.includes("subswitch serve")), "must hint 'subswitch serve' when not running");
  });

  it("returns exit code 0 with no color codes when color=false", async () => {
    const lines: string[] = [];
    const exitCode = await runDoctor(makeTestConfig(), "/path/subswitch.config.json", true, {
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
    const exitCode = await runDoctor(makeTestConfig(), "/path/subswitch.config.json", true, {
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
    await runDoctor(makeTestConfig(), "/path/subswitch.config.json", true, allPassIO(lines));
    // The alias table renders rows like: "sol  →  gpt-5.6-sol  gen:5.6  enabled  (derived)"
    // Assert on content only the table can produce — the → separator together with
    // the specific alias name, its canonical, and the generation column.
    // "sol" alone is vacuous because makeTestConfig already includes "gpt-5.6-sol"
    // in codex.models, so the substring matches the models row regardless.
    const tableLine = lines.find((l) => l.includes("sol") && l.includes("→") && l.includes("gpt-5.6-sol") && l.includes("gen:5.6"));
    assert.ok(tableLine !== undefined, "alias table must render a row: sol → gpt-5.6-sol gen:5.6 ...");
  });

  it("emits a nudge line when codexModelsPinned is true", async () => {
    const lines: string[] = [];
    await runDoctor(makeTestConfig(), "/path/subswitch.config.json", true, allPassIO(lines), true);
    const output = lines.join("\n");
    assert.ok(
      output.includes("aliases") || output.includes("family"),
      "must include a nudge about family aliases when codexModelsPinned=true",
    );
  });

  it("does not emit a nudge line when codexModelsPinned is false", async () => {
    const lines: string[] = [];
    await runDoctor(makeTestConfig(), "/path/subswitch.config.json", true, allPassIO(lines), false);
    const output = lines.join("\n");
    // The nudge mentions "consider using family aliases" — should be absent when false.
    assert.ok(
      !output.includes("consider using family aliases"),
      "must not emit the alias nudge when codexModelsPinned=false",
    );
  });
});

describe("runDoctor — agent model scan", () => {
  it("returns exit code 1 when an agent file has an unresolvable model", async () => {
    const lines: string[] = [];
    const exitCode = await runDoctor(makeTestConfig(), "/path/subswitch.config.json", true, {
      ...allPassIO(lines),
      listAgentFiles: async () => ["/project/.claude/agents/bad-agent.md"],
      readTextFile: async () => "---\nmodel: totally-unknown-model\n---\n",
    });
    assert.equal(exitCode, 1, "unresolvable agent model should cause exit code 1");
  });

  it("emits a FAIL row for an unresolvable agent model", async () => {
    const lines: string[] = [];
    // Directory-aware fake: the project dir arg is relative (".claude/agents")
    // while the user dir arg is absolute ("~/. claude/agents"). Pre-fix production
    // code returned raw strings — ".claude/agents/x.md" vs "/home/.../.claude/agents/x.md"
    // — that the new Set([...]) could not deduplicate, causing every finding to be
    // reported twice when doctor runs from $HOME. The fake simulates what the fixed
    // factory (makeLiveListAgentFiles) returns after resolving both dirs to the same
    // absolute path: both calls yield the identical absolute file path.
    const agentFile = join(homedir(), ".claude", "agents", "bad-agent.md");
    await runDoctor(makeTestConfig(), "/path/subswitch.config.json", true, {
      ...allPassIO(lines),
      listAgentFiles: async (dir: string): Promise<readonly string[]> => {
        // Both the project dir and the user dir include ".claude/agents" — return
        // the same absolute path for each to simulate the post-fix deduplicated state.
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
    // Pre-fix: the Set received ".claude/agents/x.md" and "/home/.../.claude/agents/x.md"
    // — two distinct strings for the same file — and reported the finding twice.
    const failRows = lines.filter((l) => l.includes("totally-unknown-model"));
    assert.equal(failRows.length, 1, "a file discovered under both agent dirs must report once");
  });

  it("does not increment failures for an Anthropic tier name in agent frontmatter", async () => {
    const lines: string[] = [];
    const exitCode = await runDoctor(makeTestConfig(), "/path/subswitch.config.json", true, {
      ...allPassIO(lines),
      listAgentFiles: async () => ["/project/.claude/agents/claude-main.md"],
      readTextFile: async () => "---\nmodel: sonnet\n---\n",
    });
    assert.equal(exitCode, 0, "Anthropic tier names should not cause failures");
  });

  it("does not fail when the agents directory is absent (listAgentFiles returns empty)", async () => {
    const lines: string[] = [];
    const exitCode = await runDoctor(makeTestConfig(), "/path/subswitch.config.json", true, {
      ...allPassIO(lines),
      listAgentFiles: async () => [],
      readTextFile: async () => "",
    });
    assert.equal(exitCode, 0, "absent agents directory should not cause a failure");
  });

  it("labels only the first agent finding row with 'agent model:'; subsequent rows use a blank label", async () => {
    const lines: string[] = [];
    await runDoctor(makeTestConfig(), "/path/subswitch.config.json", true, {
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
});

// ---------------------------------------------------------------------------
// makeLiveListAgentFiles — factory-level absolute path resolution (item 1 guard)
// ---------------------------------------------------------------------------
//
// The production fix for the $HOME dedup bug lives in the factory: it calls
// pathResolve(dir) before building result paths so that a relative project dir
// (".claude/agents") and an absolute user dir ("~/.claude/agents") produce the
// same strings when they point to the same physical location, letting the Set in
// runDoctor collapse them.
//
// The DoctorIO injection seam cannot reach this code path, so no fake injected
// through listAgentFiles can exercise it. This test exercises the real factory
// against the real filesystem.
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
      // Pre-fix: relResult contained a relative path, absResult an absolute path —
      // two distinct strings for the same file — so new Set() never collapsed them
      // and every finding was reported twice.  Post-fix: both are absolute, the Set
      // collapses them to one entry.
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
