/** Explicit future-model declarations use fabricated config and injected doctor I/O only. */
import assert from "node:assert/strict";
import { describe, it, type TestContext } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../../src/config.js";
import { buildDeps } from "../../src/server.js";
import { runDoctor, type DoctorIO } from "../../src/doctor.js";
import { noopLogger } from "../../src/logger.js";
import { MODEL_REGISTRY, buildRoutingTable, resolveModel } from "../../src/models.js";

const future = "gpt-fixture-next-sol";

function fixture(t: TestContext, aliases: Record<string, unknown> = { sol: future, worker: future }) {
  const root = mkdtempSync(join(tmpdir(), "subswitch-future-model-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const loaded = loadConfig({
    configPath: join(root, "config.json"), env: {},
    readFile: () => JSON.stringify({
      anthropic: { baseUrl: "http://127.0.0.1:1/anthropic" },
      providers: { codex: {
        aliases, authFile: join(root, "absent-auth.json"),
        baseUrl: "http://127.0.0.1:1/codex", oauthTokenUrl: "http://127.0.0.1:1/refresh",
      } },
      codexIngress: {
        subscriptionBaseUrl: "http://127.0.0.1:1/subscription", apiBaseUrl: "http://127.0.0.1:1/api",
        claude: {
          baseUrl: "http://127.0.0.1:1/claude", oauthTokenUrl: "http://127.0.0.1:1/claude-refresh",
          authFile: join(root, "absent-claude.json"), configDir: join(root, "absent-claude-config"),
        },
      },
    }),
  });
  assert.ok(loaded.ok, loaded.ok ? "" : loaded.error.message);
  return { root, config: loaded.value.config };
}

function doctorIO(lines: string[], root: string, models: string[]): DoctorIO {
  return {
    color: false, write: line => lines.push(line),
    readAuthFile: async () => JSON.stringify({ auth_mode: "oauth", tokens: {
      access_token: "eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJmYWJyaWNhdGVkIn0.sig", refresh_token: "fabricated-refresh",
    } }),
    httpGet: async () => ({ ok: true, status: 200, body: JSON.stringify({ name: "subswitch", version: "fixture" }) }),
    tlsConnect: async () => ({ kind: "reachable" }),
    listAgentFiles: async () => models.map((_model, i) => join(root, `agent-${i}.md`)),
    readTextFile: async path => {
      const index = Number(/agent-(\d+)\.md$/.exec(path)?.[1]);
      return `---\nmodel: ${models[index]}\n---\n`;
    },
  };
}

describe("explicit future Codex model overrides", () => {
  for (const requested of ["sol", "worker", "codex:sol", "codex:worker", future, `codex:${future}`]) {
    it(`loads and selects the explicitly configured future target for ${requested}`, t => {
      const { config } = fixture(t);
      assert.equal(config.providers.codex.aliases.sol, future);
      const deps = buildDeps(config, noopLogger);
      assert.ok(deps.ok);
      try {
        assert.deepEqual(deps.value.resolve(requested), { kind: "resolved", target: { id: future, provider: "codex" } });
      } finally { deps.value.forwardAnthropic.close?.(); deps.value.forwardOpenai?.close(); }
    });
  }

  it("doctor warns about unverified provider support without failing declared aliases or full/qualified IDs", async t => {
    const { config, root } = fixture(t);
    const lines: string[] = [];
    const status = await runDoctor(config, join(root, "config.json"), true,
      doctorIO(lines, root, ["sol", "codex:sol", future, `codex:${future}`]), new Set(["codex"]));
    assert.equal(status, 0);
    assert.match(lines.join("\n"), /target not in registry/);
    assert.match(lines.join("\n"), /upstream support.*not verified/);
    assert.ok(!lines.some(line => line.includes("FAIL")));
  });

  it("keeps doctor failures for unconfigured unknown agent models", async t => {
    const { config, root } = fixture(t);
    const lines: string[] = [];
    assert.equal(await runDoctor(config, join(root, "config.json"), true,
      doctorIO(lines, root, ["gpt-fixture-undeclared"]), new Set(["codex"])), 1);
    assert.ok(lines.some(line => line.includes("gpt-fixture-undeclared") && line.includes("FAIL")));
  });

  it("preserves canonical pins, one-hop aliases and unresolved undeclared names", () => {
    const { table } = buildRoutingTable(MODEL_REGISTRY, { codex: {
      sol: future, "gpt-6.1-sol": future, a: "b", b: "gpt-6-sol",
    } });
    for (const name of ["gpt-6.1-sol", "codex:gpt-6.1-sol"])
      assert.equal((resolveModel(table, name) as { target: { id: string } }).target.id, "gpt-6.1-sol");
    for (const name of ["a", "codex:a"])
      assert.equal((resolveModel(table, name) as { target: { id: string } }).target.id, "b");
    for (const name of ["b", "codex:b"])
      assert.equal((resolveModel(table, name) as { target: { id: string } }).target.id, "gpt-6-sol");
    for (const name of ["gpt-fixture-undeclared", "codex:gpt-fixture-undeclared"])
      assert.deepEqual(resolveModel(table, name), { kind: "unresolved" });
    assert.deepEqual(resolveModel(table, "typo:sol"), { kind: "unknown_qualifier", qualifier: "typo" });
  });

  it("does not let target-only declarations claim existing family or qualified registry names", () => {
    const { table } = buildRoutingTable(MODEL_REGISTRY, { codex: {
      worker: "sol", literal: "codex:gpt-6.1-sol", next: future, literalAlias: "codex:next",
    } });
    for (const name of ["sol", "codex:sol", "codex:gpt-6.1-sol"])
      assert.equal((resolveModel(table, name) as { target: { id: string } }).target.id, "gpt-6.1-sol");
    assert.equal((resolveModel(table, "worker") as { target: { id: string } }).target.id, "sol");
    assert.equal((resolveModel(table, "literal") as { target: { id: string } }).target.id, "codex:gpt-6.1-sol");
    assert.equal((resolveModel(table, "codex:next") as { target: { id: string } }).target.id, future);
    assert.equal((resolveModel(table, "literalAlias") as { target: { id: string } }).target.id, "codex:next");
  });

  it("keeps malformed/reserved aliases and unsupported configured providers invalid", () => {
    for (const value of [
      { providers: { codex: { aliases: { "": future } } } },
      { providers: { codex: { aliases: { sol: "" } } } },
      { providers: { codex: { aliases: { sol: 42 } } } },
      { providers: { codex: { aliases: { sonnet: future } } } },
      { providers: { codex: { aliases: { sol: "claude-fixture" } } } },
      { providers: { codexx: { aliases: { sol: future } } } },
    ]) {
      const loaded = loadConfig({ configPath: "/fabricated/no-read.json", env: {}, readFile: () => JSON.stringify(value) });
      assert.equal(loaded.ok, false, JSON.stringify(value));
    }
  });
});
