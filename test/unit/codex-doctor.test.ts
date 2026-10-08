import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { runCodexDoctor } from "../../src/codex-doctor.js";
import { loadConfig } from "../../src/config.js";

describe("Codex doctor", () => {
  it("continues independent diagnostics after credential, health, or TLS failures", async () => {
    const loaded = loadConfig({ configPath: "fixture", readFile: () => '{"codexIngress":{"enabled":true,"claude":{"enabled":true}}}' });
    assert.ok(loaded.ok);
    const output: string[] = [];
    const result = await runCodexDoctor(loaded.value.config, line => output.push(line), {
      env: { CODEX_HOME: "/fixture/native" }, project: "/fixture/project", color: true,
      read: async () => null, auth: async () => { throw new Error("private fixture"); },
      httpGet: async () => { throw new Error("private fixture"); }, tlsConnect: async () => { throw new Error("private fixture"); },
    });
    assert.equal(result, 1);
    const text = output.join("\n");
    assert.match(text, /Claude subscription/); assert.match(text, /Claude connectivity/); assert.match(text, /Codex setup/);
    assert.match(text, /check\(s\) failed/); assert.ok(!text.includes("private fixture")); assert.match(text, /\u001b\[/);
  });
  it("rejects an unversioned health claim and still checks healthy sibling role files", async () => {
    const loaded = loadConfig({ configPath: "fixture", readFile: () => '{"codexIngress":{"enabled":true,"claude":{"enabled":true}}}' });
    assert.ok(loaded.ok);
    const output: string[] = [];
    await runCodexDoctor(loaded.value.config, line => output.push(line), {
      env: { CODEX_HOME: "/fixture/native" }, project: "/fixture/project",
      read: async path => path === "/fixture/native/config.toml" ? '[agents.broken]\nconfig_file="broken.toml"\n[agents.working]\nmodel="sonnet"' :
        path === "/fixture/native/broken.toml" ? 'model="unfinished' : null,
      auth: async () => ({ available: true, expired: true, refreshable: true }),
      httpGet: async () => ({ ok: true, status: 200, body: '{"codexIngress":{"translationAvailable":true}}' }),
      tlsConnect: async () => ({ kind: "reachable" }),
    });
    const text = output.join("\n");
    assert.match(text, /start subswitch serve/); assert.match(text, /agent broken:.*FAIL/);
    assert.match(text, /agent working: sonnet → claude-sonnet-5-5/); assert.match(text, /refresh required/);
  });
  it("checks routing, auth, native setup and configured agent model files without refreshing", async () => {
    const loaded = loadConfig({ configPath: "fixture", readFile: () => '{"providers":{"codex":{"authFile":"/fixture/native/auth.json"}},"codexIngress":{"enabled":true,"claude":{"enabled":true}}}' });
    assert.ok(loaded.ok);
    const output: string[] = [];
    const result = await runCodexDoctor(loaded.value.config, line => output.push(line), {
      env: { CODEX_HOME: "/fixture/native" }, project: "/fixture/project",
      read: async path => path === "/fixture/native/config.toml" ? 'openai_base_url = "http://127.0.0.1:4141/codex/backend-api/codex"\n[agents.worker]\nconfig_file = "worker.toml"' :
        path === "/fixture/native/worker.toml" ? 'model = "sonnet"' : path === "/fixture/native/auth.json" ?
          '{"tokens":{"access_token":"fixture-access","refresh_token":"fixture-refresh","account_id":"fixture-account"}}' : null,
      auth: async () => ({ available: true, expired: false, refreshable: true }),
      httpGet: async () => ({ ok: true, status: 200, body: '{"codexIngress":{"schemaVersion":1,"enabled":true,"mode":"model-routing","translationAvailable":true,"credentials":"client","transports":["http","websocket"]}}' }),
      tlsConnect: async () => ({ kind: "reachable" }),
    });
    assert.equal(result, 0); assert.match(output.join("\n"), /agent worker: sonnet → claude-sonnet-5-5/);
  });
  it("flags every agent model the reverse leg would refuse as an unregistered Claude name", async () => {
    const loaded = loadConfig({ configPath: "fixture", readFile: () => '{"codexIngress":{"enabled":true,"claude":{"enabled":true}}}' });
    assert.ok(loaded.ok);
    const output: string[] = [];
    await runCodexDoctor(loaded.value.config, line => output.push(line), {
      env: { CODEX_HOME: "/fixture/native" }, project: "/fixture/project",
      read: async path => path === "/fixture/native/config.toml"
        ? '[agents.deep]\nmodel="opus"\n[agents.future]\nmodel="claude-sonnet-future"\n[agents.shouty]\nmodel="Claude-Opus-5"\n[agents.native]\nmodel="gpt-6-sol"' : null,
      auth: async () => ({ available: true, expired: false, refreshable: true }),
      httpGet: async () => ({ ok: false, connectionRefused: true }), tlsConnect: async () => ({ kind: "reachable" }),
    });
    const text = output.join("\n");
    assert.match(text, /agent deep: opus → claude-opus-5-5/);
    assert.match(text, /agent future:.*FAIL.*not in the registry/); assert.match(text, /agent shouty:.*FAIL.*not in the registry/);
    assert.doesNotMatch(text, /agent native/);
  });
  it("fails missing credentials, disabled routing, and unavailable native setup", async () => {
    const loaded = loadConfig({ configPath: "fixture", readFile: () => "{}" }); assert.ok(loaded.ok);
    const output: string[] = [];
    const result = await runCodexDoctor(loaded.value.config, line => output.push(line), {
      env: { CODEX_HOME: "/fixture/native" }, project: "/fixture/project", read: async () => null,
      auth: async () => ({ available: false, expired: false, refreshable: false }),
      httpGet: async () => ({ ok: false, connectionRefused: true }), tlsConnect: async () => ({ kind: "reachable" }),
    });
    assert.equal(result, 1); assert.match(output.join("\n"), /sign in with Claude Code/); assert.match(output.join("\n"), /start subswitch serve/);
  });
});
