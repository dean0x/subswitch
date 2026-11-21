import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { homedir, tmpdir } from "node:os";
import { mkdtemp, mkdir, writeFile, rm, realpath } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import {
  probeSubswitch,
  probeTlsReachable,
  runDoctor,
  makeLiveListAgentFiles,
  PROVIDER_AUTH_INSPECTORS,
  type DoctorAuthInspection,
  type HttpGetResult,
  type TlsStatus,
  type DoctorIO,
} from "../../src/doctor.js";
import { err, ok } from "../../src/result.js";
import { registerExactCredential } from "../../src/errors.js";
import { loadConfig, type Config } from "../../src/config.js";
import { PROVIDER_IDS, type ProviderId, type RoutingTable } from "../../src/models.js";
import { checkAgentModels } from "../../src/agent-scan.js";
import { TOGETHER_API_KEY_ENV } from "../../src/together-auth.js";
import { keychainBackedCodex, keychainCredential } from "../fixtures/native-keychain.js";
import type { KeychainReaderDeps } from "../../src/keychain-read.js";
import { buildTestDeps } from "../helpers/server-deps.js";

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

const keychainDoctor = async (active: boolean, stdout: string | undefined, loginCommand: string = keychainCredential.loginCommand) => {
  const loaded = loadConfig({ configPath: "fixture", readFile: () => active ? '{"providers":{"codex":{}}}' : "{}", env: {} });
  assert.ok(loaded.ok);
  const { config, configuredProviders } = loaded.value;
  const providerConfigFor = keychainBackedCodex(configuredProviders.has("codex"), { ...keychainCredential, loginCommand });
  const server = buildTestDeps(config, { log: () => {} }, { providerConfigFor });
  assert.ok(server.ok);
  const destination = server.value.destinations.find((d) => d.id === "codex");
  assert.ok(destination?.routing === "registry");
  assert.equal(destination.active, active);
  const lines: string[] = [];
  const calls: (readonly [string, readonly string[]])[] = [];
  const hosts: string[] = [];
  const authReads: string[] = [];
  const keychainReader: KeychainReaderDeps = {
    platform: "darwin", env: {}, loginKeychainPath: "/fixture/login.keychain-db", setTimer: () => () => {},
    exec: async (file, args) => { calls.push([file, args]); return { stdout: stdout ?? "" }; },
  };
  const code = await runDoctor(config, "fixture", true, {
    ...allPassIO(lines), providerConfigFor, ...(stdout === undefined ? {} : { keychainReader }),
    readAuthFile: async (path) => { authReads.push(path); return ""; },
    tlsConnect: async (host) => { hosts.push(host); return { kind: "reachable" }; },
    listAgentFiles: async () => ["/fixture/agent.md"],
    readTextFile: async () => "---\nmodel: gpt-5.6-sol\n---\n",
  }, configuredProviders);
  assert.deepEqual(authReads, []);
  return { code, calls, hosts, output: lines.join("\n") };
};

it("probes only Keychain attributes and shows the modification time when the block exists", async () => {
  const fake = "FAKE-KEYCHAIN-OUTPUT";
  const { code, calls, hosts, output } = await keychainDoctor(true,
    `attributes:\n    "mdat"<timedate>=0x32303234303232393132333435365A00  "20240229123456Z\\000"\n${fake}\n`);
  assert.deepEqual(calls, [["/usr/bin/security", [
    "find-generic-password", "-s", "Fake Codex Sign-in", "-a", "fake-account", "/fixture/login.keychain-db",
  ]]]);
  assert.equal(code, 0);
  assert.ok(hosts.includes("upstream.example.test"));
  assert.match(output, /codex auth:\s+Keychain item found/);
  assert.match(output, /Keychain modified:\s+2024-02-29T12:34:56\.000Z/);
  assert.equal(output.includes(fake), false);
  assert.doesNotMatch(output, /agent model:/);
});

it("does not probe an inactive Keychain provider and reports its workspace pin", async () => {
  const { code, calls, hosts, output } = await keychainDoctor(false, "");
  assert.deepEqual(calls, []);
  assert.equal(hosts.includes("upstream.example.test"), false);
  assert.match(output, /codex auth:\s+not turned on/);
  assert.match(output, /agent model:\s+FAIL.*gpt-5\.6-sol.*provider is not configured/);
  assert.equal(code, 1);
});

it("returns exit code 1 and reports probe_unavailable when the Keychain probe is absent", async () => {
  const { code, output } = await keychainDoctor(true, undefined);
  assert.equal(code, 1);
  assert.match(output, /codex auth:\s+UNAVAILABLE \(probe_unavailable .*fixture login/);
});

it("prints only a fixed failure code for malformed Keychain output", async () => {
  const fake = "FAKE-MALFORMED-KEYCHAIN-OUTPUT";
  const { code, output } = await keychainDoctor(true, fake);
  assert.match(output, /codex auth:\s+UNAVAILABLE \(malformed .*fixture login/);
  assert.equal(output.includes(fake), false);
  assert.equal(code, 1);
});

it("redacts the Keychain auth row at the doctor write site", async () => {
  const fake = "FAKE-KEYCHAIN-REDACTION-CONTROL";
  assert.equal(registerExactCredential("codex", fake), true);
  const { output } = await keychainDoctor(true, "", `fixture login ${fake}`);
  assert.match(output, /codex auth:\s+UNAVAILABLE .*fixture login /);
  assert.equal(output.includes(fake), false);
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
    const codexFile = lines.findIndex((line) => line.includes("codex.authFile:"));
    const codexMode = lines.findIndex((line) => line.includes("codex auth mode:"));
    const together = lines.findIndex((line) => line.includes("together auth:"));
    assert.ok(codexFile >= 0 && codexMode > codexFile && together > codexMode);
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
    // "not-a-provider:other-model" has an unknown_qualifier resolution — the prefix
    // "not-a-provider" is not in PROVIDER_IDS and never will be. subswitch forwards it to
    // Anthropic unchanged, so flagging it as a failure would be a lie (ADR-010). The finding must be severity "info" → exit 0.
    //
    // Mutation that MUST turn this RED: change `severity: "info"` back to `severity: "fail"`
    // in the unknown_qualifier arm of checkAgentModels → exitCode becomes 1 → assertion fails.
    const lines: string[] = [];
    const exitCode = await runDoctor(defaultConfig(), "/path/subswitch.config.json", true, {
      ...allPassIO(lines),
      listAgentFiles: async () => ["/project/.claude/agents/exotic.md"],
      readTextFile: async () => "---\nmodel: not-a-provider:other-model\n---\n",
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
      readTextFile: async () => "---\nmodel: not-a-provider:other-model\n---\n",
    });
    const output = lines.join("\n");
    assert.ok(output.includes("not-a-provider:other-model"), "output must mention the model name");
    assert.ok(output.includes("not-a-provider"), "output must mention the unknown qualifier");
    // Must NOT emit a FAIL row for unknown_provider (it is info).
    const findingLine = lines.find((l) => l.includes("not-a-provider:other-model"));
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

describe("doctor auth inspector dispatch", () => {
  const neutralInspection: DoctorAuthInspection = {
    kind: "oauth-file",
    authFile: "/fixture/other/credential.json",
    loginCommand: "fixture login",
    result: ok({
      identity: [{ label: "fixture identity:", value: "first", pass: true }],
      expiresAt: "2031-02-03T04:05:06.000Z",
      renewal: [{ label: "fixture renewal:", value: "due" }],
    }),
  };
  const presentKey: DoctorAuthInspection = { kind: "api-key", key: { kind: "present", source: "env" } };

  it("calls each provider's own inspector once with that provider's config slice and the doctor io", async (t) => {
    const config = defaultConfig();
    const io = allPassIO([]);
    const codex = t.mock.method(PROVIDER_AUTH_INSPECTORS, "codex", async () => neutralInspection);
    const together = t.mock.method(PROVIDER_AUTH_INSPECTORS, "together", async () => presentKey);
    await runDoctor(config, "fixture", true, io);
    assert.deepEqual(codex.mock.calls.map((call) => call.arguments.length), [2]);
    assert.equal(codex.mock.calls[0]?.arguments[0], config.providers.codex);
    assert.equal(codex.mock.calls[0]?.arguments[1], io);
    assert.deepEqual(together.mock.calls.map((call) => call.arguments.length), [2]);
    assert.equal(together.mock.calls[0]?.arguments[0], config.providers.together);
    assert.equal(together.mock.calls[0]?.arguments[1], io);
  });

  it("writes an oauth-file row from the neutral row: its lines, the expiry line, then its renewal lines", async (t) => {
    const lines: string[] = [];
    t.mock.method(PROVIDER_AUTH_INSPECTORS, "codex", async () => neutralInspection);
    const exitCode = await runDoctor(defaultConfig(), "fixture", true, allPassIO(lines), new Set<ProviderId>(["codex"]));
    const start = lines.findIndex((line) => line.startsWith("  codex.authFile:"));
    assert.deepEqual(lines.slice(start, start + 4), [
      `${"  codex.authFile:".padEnd(22)}/fixture/other/credential.json`,
      `${"  fixture identity:".padEnd(22)}first`,
      `${"  token expires:".padEnd(22)}2031-02-03T04:05:06.000Z`,
      `${"  fixture renewal:".padEnd(22)}due`,
    ]);
    assert.match(lines[start + 4] ?? "", /^ {2}together auth:/, "the Codex rows end after the renewal lines");
    assert.equal(exitCode, 0);
  });

  const fakeJwt = `eyJfixture.${randomUUID()}.fakesignature`;

  it("scrubs the label and value of a neutral auth field", async (t) => {
    const fakeExact = `FAKE-TOGETHER-KEY-${randomUUID()}`;
    assert.equal(registerExactCredential("together", fakeExact), true);
    t.mock.method(PROVIDER_AUTH_INSPECTORS, "codex", async (): Promise<DoctorAuthInspection> => ({
      ...neutralInspection,
      result: ok({
        identity: [{ label: `fixture account ${fakeJwt}:`, value: fakeExact, pass: true }],
        expiresAt: undefined,
        renewal: [],
      }),
    }));
    const lines: string[] = [];
    const exitCode = await runDoctor(defaultConfig(), "fixture", true, allPassIO(lines));
    const line = lines.find((text) => text.startsWith("  fixture account ")) ?? "";
    assert.equal(line.includes(fakeJwt) || line.includes(fakeExact), false, "Doctor must scrub both auth field parts");
    assert.match(line, /^ {2}fixture account <redacted-jwt>:\s*<redacted>$/);
    assert.equal(exitCode, 0);
  });

  it("scrubs the invalid auth message and keeps exit code 1", async (t) => {
    t.mock.method(PROVIDER_AUTH_INSPECTORS, "codex", async (): Promise<DoctorAuthInspection> => ({
      ...neutralInspection,
      result: err({ kind: "invalid", message: `fixture error for ${fakeJwt}` }),
    }));
    const lines: string[] = [];
    const exitCode = await runDoctor(defaultConfig(), "fixture", true, allPassIO(lines));
    const line = lines.find((text) => text.startsWith("  codex auth:")) ?? "";
    assert.equal(line.includes(fakeJwt), false, "Doctor must scrub the invalid auth message");
    assert.match(line, /^ {2}codex auth:\s+INVALID \(fixture error for <redacted-jwt>\)$/);
    assert.equal(exitCode, 1);
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

it("doctor checks Together once through its injected Keychain seam and reports only the source", async (t) => {
  const key = "FAKE-TOGETHER-KEY-doctor";
  const exec = t.mock.fn(async () => ({ stdout: `${key}\n` }));
  const lines: string[] = [];
  const loaded = loadConfig({ configPath: "fixture", readFile: () => "{}", env: {} });
  assert.ok(loaded.ok);
  const exitCode = await runDoctor(loaded.value.config, "fixture", true, {
    ...allPassIO(lines), togetherKeyReader: { env: {}, platform: "darwin", exec, setTimer: () => () => {} },
  });
  assert.equal(exec.mock.callCount(), 1);
  assert.equal(exitCode, 0);
  assert.match(lines.join("\n"), /together auth:\s+OK \(keychain\)$/m);
  assert.ok(!lines.join("\n").includes(key));
});

// ---------------------------------------------------------------------------
// Codex auth row text — byte-for-byte pin, colour on
// ---------------------------------------------------------------------------
// The doctor auth seam must leave every Codex row exactly as it was: the same
// labels, padding, colour codes, order, hints and exit codes.

describe("doctor Codex auth row text", () => {
  const authFilePath = "/fixture/codex/auth.json";
  const jwt = (claims: Record<string, unknown>): string =>
    `eyJhbGciOiJub25lIn0.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.sig`;
  const fullToken = jwt({ exp: 1_893_456_000, "https://api.openai.com/auth": { chatgpt_account_id: "acct-fixture-123456" } });
  const fullFile = JSON.stringify({
    auth_mode: "chatgpt", last_refresh: "2026-01-02T03:04:05Z", tokens: { access_token: fullToken, refresh_token: "ref" },
  });
  const bareFile = JSON.stringify({ tokens: { access_token: jwt({ sub: "fixture" }), refresh_token: "ref" } });
  const failure = (message: string, code?: string): Error => Object.assign(new Error(message), code === undefined ? {} : { code });
  const label = (text: string): string => `  ${text}`.padEnd(22);
  const green = (text: string): string => `\u001b[32m${text}\u001b[39m`;
  const red = (text: string): string => `\u001b[31m${text}\u001b[39m`;
  const dim = (text: string): string => `\u001b[2m${text}\u001b[22m`;
  const fileRow = `${label("codex.authFile:")}${authFilePath}`;
  interface CodexRowCase {
    readonly name: string;
    readonly read: () => Promise<string>;
    readonly optedIn: boolean;
    readonly exit: number;
    readonly lines: readonly string[];
  }
  const rows: readonly CodexRowCase[] = [
    {
      name: "a full auth file", read: async () => fullFile, optedIn: false, exit: 0,
      lines: [fileRow, `${label("codex auth mode:")}${green("chatgpt")}`, `${label("codex account:")}…123456`,
        `${label("token expires:")}2030-01-01T00:00:00.000Z`, `${label("last refresh:")}2026-01-02T03:04:05Z`],
    },
    {
      name: "an auth file with no mode, account, expiry or refresh time", read: async () => bareFile, optedIn: true, exit: 0,
      lines: [fileRow, `${label("codex auth mode:")}${green("unknown")}`, `${label("codex account:")}(none)`,
        `${label("token expires:")}(no exp claim)`, `${label("last refresh:")}(unknown)`],
    },
    {
      name: "an auth file that does not parse", read: async () => "not json", optedIn: false, exit: 1,
      lines: [fileRow, `${label("codex auth:")}${red("INVALID (codex auth file is not valid JSON — run `codex login`)")}`],
    },
    {
      name: "an unreadable auth file and no codex block", read: async () => { throw failure("EACCES: permission denied", "EACCES"); },
      optedIn: false, exit: 0,
      lines: [fileRow, `${label("codex auth:")}${dim("unconfigured")} (run \`codex login\` to enable codex routing)`],
    },
    {
      name: "a missing auth file and a codex block", read: async () => { throw failure("ENOENT: no such file", "ENOENT"); },
      optedIn: true, exit: 1,
      lines: [fileRow, `${label("codex auth:")}${red("UNAVAILABLE")} (no auth file — run \`codex login\`)`,
        "  note: the Anthropic leg works without codex auth; only codex models are affected"],
    },
    {
      name: "a missing auth file named only in the error message and a codex block",
      read: async () => { throw failure("ENOENT: no such file"); }, optedIn: true, exit: 1,
      lines: [fileRow, `${label("codex auth:")}${red("UNAVAILABLE")} (no auth file — run \`codex login\`)`,
        "  note: the Anthropic leg works without codex auth; only codex models are affected"],
    },
    {
      name: "an unreadable auth file and a codex block", read: async () => { throw failure("EACCES: permission denied", "EACCES"); },
      optedIn: true, exit: 1,
      lines: [fileRow, `${label("codex auth:")}${red("UNAVAILABLE")} (cannot read auth file — run \`codex login\`)`,
        "  note: the Anthropic leg works without codex auth; only codex models are affected"],
    },
  ];

  for (const row of rows) {
    it(`writes the same Codex rows and exit code for ${row.name}`, async (t) => {
      const loaded = loadConfig({ configPath: "fixture", env: {},
        readFile: () => JSON.stringify({ providers: { codex: { authFile: authFilePath } } }) });
      assert.ok(loaded.ok);
      const lines: string[] = [];
      const readAuthFile = t.mock.fn(row.read);
      const exitCode = await runDoctor(loaded.value.config, "fixture", true,
        { ...allPassIO(lines), color: true, readAuthFile },
        new Set<ProviderId>(row.optedIn ? ["codex"] : []));
      const start = lines.indexOf(fileRow);
      const end = lines.findIndex((line, index) => index > start && line.startsWith("  together"));
      assert.ok(start >= 0 && end > start, lines.join("\n"));
      assert.deepEqual(lines.slice(start, end), row.lines);
      assert.equal(exitCode, row.exit);
      assert.deepEqual(readAuthFile.mock.calls.map((call) => call.arguments), [[authFilePath]]);
    });
  }
});

describe("doctor Together key severity matrix", () => {
  const key = "FAKE-TOGETHER-KEY-doctor-matrix";
  const envOnly = /\(Set TOGETHER_API_KEY \(environment variable only on this platform\)\.\)/;
  const keychainHint = /\(Set TOGETHER_API_KEY or add the macOS Keychain item "Subswitch Together API key"\.\)/;
  const rows = [
    { name: "no block, pin or key", block: false, pin: false, value: undefined, platform: "linux", exit: 0, auth: /together auth:\s+unconfigured /, hint: envOnly },
    { name: "a block and no key", block: true, pin: false, value: undefined, platform: "linux", exit: 1, auth: /together auth:\s+UNAVAILABLE /, hint: envOnly },
    { name: "a pin and no key", block: false, pin: true, value: undefined, platform: "linux", exit: 1, auth: /together auth:\s+unconfigured /, hint: envOnly },
    { name: "a block and a malformed key", block: true, pin: false, value: `${key} x`, platform: "linux", exit: 1, auth: /together auth:\s+UNAVAILABLE \(key is malformed\) /, hint: envOnly },
    { name: "a pin and an env key", block: false, pin: true, value: key, platform: "linux", exit: 0, auth: /together auth:\s+OK \(env\)$/m, hint: undefined },
    { name: "no block and no key on macOS", block: false, pin: false, value: undefined, platform: "darwin", exit: 0, auth: /together auth:\s+unconfigured /, hint: keychainHint },
  ] as const;

  for (const row of rows) {
    it(`exits ${row.exit} for ${row.name}`, async (t) => {
      const lines: string[] = [];
      const exec = t.mock.fn(async (): Promise<{ stdout: string }> => { throw new Error("item not found"); });
      const loaded = loadConfig({ configPath: "fixture", env: {},
        readFile: () => JSON.stringify(row.block ? { providers: { together: {} } } : {}) });
      assert.ok(loaded.ok);
      const exitCode = await runDoctor(loaded.value.config, "fixture", true, {
        ...allPassIO(lines),
        togetherKeyReader: { env: row.value === undefined ? {} : { [TOGETHER_API_KEY_ENV]: row.value },
          platform: row.platform, exec, setTimer: () => () => {} },
        listAgentFiles: async () => (row.pin ? ["/project/.claude/agents/worker.md"] : []),
        readTextFile: async () => "---\nmodel: together:fixture/unlisted\n---\n",
      }, loaded.value.configuredProviders);
      const output = lines.join("\n");
      assert.equal(exitCode, row.exit, output);
      assert.match(output, row.auth);
      if (row.hint !== undefined) assert.match(output, row.hint);
      if (row.platform === "linux") assert.doesNotMatch(output, /Keychain/);
      assert.equal(exec.mock.callCount(), row.platform === "darwin" ? 1 : 0);
      const agentRow = /agent model:\s+FAIL \/project\/\.claude\/agents\/worker\.md: model "together:fixture\/unlisted"/;
      if (row.pin && row.value === undefined) assert.match(output, agentRow);
      else assert.doesNotMatch(output, /agent model:/);
      assert.ok(!output.includes(key), "doctor must never print the key value");
    });
  }
});
