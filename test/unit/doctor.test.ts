import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { probeSubswitch, probeTlsReachable, runDoctor, type HttpGetResult, type TlsStatus } from "../../src/doctor.js";
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
    // The alias table should contain lines for sol, terra, luna (derived from registry)
    const output = lines.join("\n");
    assert.ok(output.includes("sol"), "alias table must include sol");
    assert.ok(output.includes("→"), "alias table must include the arrow separator");
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
    await runDoctor(makeTestConfig(), "/path/subswitch.config.json", true, {
      ...allPassIO(lines),
      listAgentFiles: async () => ["/project/.claude/agents/bad-agent.md"],
      readTextFile: async () => "---\nmodel: totally-unknown-model\n---\n",
    });
    const output = lines.join("\n");
    assert.ok(
      output.includes("totally-unknown-model"),
      "output must mention the problematic model name",
    );
    // runDoctor lists the project and user agent directories separately; when both
    // resolve to the same file (doctor run from $HOME) the finding must be reported once.
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
