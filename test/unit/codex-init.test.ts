import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { planCodexEndpoint as planEndpointResult, planCodexSetup as planSetupResult } from "../../src/codex-init.js";
import { loadConfig, mergeConfigObjects } from "../../src/config.js";
import type { InitFsDeps } from "../../src/init.js";
import { resolve } from "node:path";

const unwrap = <T>(result: import("../../src/result.js").Result<T, { message: string }>): T => {
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
};
const planCodexEndpoint = (...args: Parameters<typeof planEndpointResult>) => unwrap(planEndpointResult(...args));
const planCodexSetup = async (...args: Parameters<typeof planSetupResult>) => unwrap(await planSetupResult(...args));

describe("Codex setup parity", () => {
  it("changes only the root endpoint value, preserving native settings and comments", () => {
    const original = '# comment\nmodel = "gpt-6-astra"\n"openai_base_url" = \'https://chatgpt.com/backend-api/codex\' # preserve\n[agents.worker]\nmodel = "sonnet"\n';
    const result = planCodexEndpoint(original, 4141);
    assert.equal(result.content, original.replace("'https://chatgpt.com/backend-api/codex'", '"http://127.0.0.1:4141/codex/backend-api/codex"'));
    assert.equal(planCodexEndpoint(result.content, 4141).content, result.content);
  });
  it("does not confuse multiline string content or nested keys with root settings", () => {
    const original = 'developer_instructions = """\nopenai_base_url = \'example\'\n[not_a_table]\n"""\n[model_providers.example]\nopenai_base_url = "nested"\n';
    const result = planCodexEndpoint(original, 4142);
    assert.equal(result.content, 'openai_base_url = "http://127.0.0.1:4142/codex/backend-api/codex"\n' + original);
    assert.throws(() => planCodexEndpoint('model_provider = "custom"\n', 4141), /custom model_provider/);
    assert.throws(() => planCodexEndpoint('openai_base_url = "unfinished', 4141), /Cannot parse Codex/);
  });
  it("plans all writes first and preserves a previously selected upstream", async () => {
    const files = new Map([
      ["/native/config.toml", 'openai_base_url = "https://trusted.example/v1"\nmodel = "gpt-6-astra"\n'],
      ["/global/config.json", '{"codexIngress":{"allowInsecureBaseUrl":true,"claude":{"aliases":{"worker":"claude-sonnet-5"}}}}'],
    ]);
    const fs: InitFsDeps = { readFile: async path => files.get(path) ?? null, exists: path => files.has(path), writeFile: async () => assert.fail("planning wrote files") };
    const plans = await planCodexSetup({ client: "codex", port: 4141, settingsTarget: "local" },
      { codexConfig: "/native/config.toml", subswitchConfig: "/global/config.json", project: "/project" }, fs);
    assert.equal(plans.length, 2);
    const global = JSON.parse(plans[0]!.content);
    assert.equal(global.codexIngress.subscriptionBaseUrl, "https://trusted.example/v1");
    assert.equal(global.codexIngress.allowInsecureBaseUrl, true); assert.equal(global.codexIngress.claude.enabled, true);
    assert.deepEqual(global.codexIngress.claude.aliases, { worker: "claude-sonnet-5" });
    assert.ok(!plans[1]!.preview.includes('model ='));
  });
  it("does not overwrite reverse configuration when both clients use the same config file", async () => {
    const fs: InitFsDeps = { readFile: async () => null, exists: () => false, writeFile: async () => assert.fail() };
    const plans = await planCodexSetup({ client: "all", port: 4141, settingsTarget: "local" },
      { codexConfig: "/native/config.toml", subswitchConfig: "/project/subswitch.config.json", project: "/project" }, fs);
    assert.equal(plans.filter(plan => plan.path === "/project/subswitch.config.json").length, 1);
    assert.equal(JSON.parse(plans[0]!.content).codexIngress.claude.enabled, true);
    assert.equal(plans.at(-1)?.path, "/project/.claude/settings.local.json");
  });
  it("deduplicates relative and absolute references to the same configuration", async () => {
    const fs: InitFsDeps = { readFile: async path => path === "/native/config.toml" ? 'openai_base_url = "https://trusted.example/v1"' : path.endsWith('subswitch.config.json') ? '{"codexIngress":{"allowInsecureBaseUrl":true}}' : null,
      exists: () => false, writeFile: async () => assert.fail() };
    const plans = await planCodexSetup({ client: "all", port: 4141, settingsTarget: "local" },
      { codexConfig: "/native/config.toml", subswitchConfig: "./subswitch.config.json", project: process.cwd() }, fs);
    const configWrites = plans.filter(plan => resolve(plan.path) === resolve("subswitch.config.json"));
    assert.equal(configWrites.length, 1);
    assert.equal(JSON.parse(configWrites[0]!.content).codexIngress.subscriptionBaseUrl, "https://trusted.example/v1");
  });
});

describe("user configuration fallback", () => {
  it("uses injected readers and paths for both sources and reports their provenance", () => {
    const reads: string[] = [];
    const result = loadConfig({ env: {}, homeDir: "/fixture/home", cwd: "/fixture/project", readFile: path => {
      reads.push(path);
      return path.includes("/.config/") ? '{"port":4142,"codexIngress":{"enabled":true}}' : '{"port":4143}';
    } });
    assert.ok(result.ok);
    assert.equal(result.value.config.port, 4143);
    assert.equal(result.value.config.codexIngress.enabled, true);
    assert.deepEqual(result.value.configPaths, ["/fixture/home/.config/subswitch/config.json", "/fixture/project/subswitch.config.json"]);
    assert.equal(reads.length, 2);
  });
  it("attributes a legacy user-config key to the user file", () => {
    const result = loadConfig({ env: {}, globalConfigPath: "/fixture/user.json", cwd: "/fixture/project",
      readFile: path => path === "/fixture/user.json" ? '{"codex":{}}' : "{}" });
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.match(result.error.message, /unsupported config keys in \/fixture\/user.json/);
      assert.ok(!result.error.message.includes("/fixture/project"));
    }
  });
  it("requires explicit custom-host trust before planning setup writes", async () => {
    const result = await planSetupResult({ client: "codex", port: 4141, settingsTarget: "local" },
      { codexConfig: "/native/config.toml", subswitchConfig: "/global/config.json", project: "/project" },
      { readFile: async path => path.endsWith(".toml") ? 'openai_base_url = "https://custom.example/v1"' : null,
        exists: () => false, writeFile: async () => assert.fail("planning wrote files") });
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.error.message, /custom.example.*allowInsecureBaseUrl.*global\/config.json/);
  });
  it("merges project settings over user defaults without losing sibling fields", () => {
    const result = loadConfig({ env: {}, globalConfigPath: "/fixture/global.json", readFile: path => path === "/fixture/global.json" ?
      '{"port":4142,"codexIngress":{"enabled":true,"claude":{"enabled":true,"aliases":{"worker":"claude-sonnet-5"}}}}' :
      '{"codexIngress":{"maxUpstreamSockets":64,"claude":{"aliases":{"second":"claude-opus-5"}}}}' });
    assert.ok(result.ok); assert.equal(result.value.config.port, 4142); assert.equal(result.value.config.codexIngress.claude.enabled, true);
    assert.equal(result.value.config.codexIngress.maxUpstreamSockets, 64);
    assert.deepEqual(result.value.config.codexIngress.claude.aliases, { worker: "claude-sonnet-5", second: "claude-opus-5" });
  });
  it("keeps explicit configuration authoritative and preserves own-property semantics", () => {
    const reads: string[] = [];
    const result = loadConfig({ configPath: "/explicit.json", globalConfigPath: "/ignored.json", env: {}, readFile: path => { reads.push(path); return "{}"; } });
    assert.ok(result.ok); assert.deepEqual(reads, ["/explicit.json"]);
    const merged = mergeConfigObjects({}, JSON.parse('{"__proto__":{"injected":true}}'));
    assert.equal(Object.prototype.hasOwnProperty.call(merged, "__proto__"), true);
    assert.equal(({} as Record<string, unknown>)["injected"], undefined);
  });
});
