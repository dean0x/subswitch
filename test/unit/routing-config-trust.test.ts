import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { loadConfig, type LoadConfigOptions } from "../../src/config.js";

const projectPath = "/fixture/project/subswitch.config.json";
const userPath = "/fixture/home/.config/subswitch/config.json";
const profile = {
  provider: "codex",
  product: "chatgpt-codex",

  billing: "subscription",
  account: "work",
  credential: { kind: "native-oauth", authFile: "/synthetic/auth.json" },
};
const route = {
  clients: ["claude-code"],
  primary: { profile: "work", model: "gpt-6-sol", effort: "high" },
};
const trusted = { configVersion: 2, accessProfiles: { work: profile }, routes: { work: route } };
const missing = (): never => { throw Object.assign(new Error("ENOENT"), { code: "ENOENT" }); };
const loadSources = (project: unknown, user?: unknown, options: LoadConfigOptions = {}) =>
  loadConfig({
    env: {}, cwd: "/fixture/project", homeDir: "/fixture/home",
    readFile: path => {
      if (path === projectPath) return JSON.stringify(project);
      if (path === userPath && user !== undefined) return JSON.stringify(user);
      return missing();
    },
    ...options,
  });

describe("new catalog route targets", () => {
  for (const model of ["gpt-6.2-sol", "gpt-6.2-astra", "gpt-6.1-terra", "claude-fable-5-2"]) {
    for (const effort of ["low", "medium", "high", "xhigh", "max"]) {
      it(`loads ${model} as a Claude Code primary with effort ${effort}`, () => {
        const work = model.startsWith("claude-")
          ? { ...profile, provider: "claude", product: "claude-code" }
          : profile;
        const result = loadSources({}, {
          ...trusted, accessProfiles: { work },
          routes: { work: { ...route, primary: { profile: "work", model, effort } } },
        });
        assert.ok(result.ok, result.ok ? "" : result.error.message);
        assert.deepEqual(result.value.config.routes?.work?.primary, { profile: "work", model, effort });
      });
    }
  }

  for (const model of ["gpt-6.2-sol", "gpt-6.2-astra"]) {
    for (const effort of ["none", "minimal"]) {
      it(`refuses effort ${effort} on ${model} with unsupported_effort`, () => {
        const result = loadSources({}, {
          ...trusted, routes: { work: { ...route, primary: { profile: "work", model, effort } } },
        });
        assert.ok(!result.ok);
        assert.match(result.error.message, /unsupported_effort/);
        assert.doesNotMatch(result.error.message, /invalid_target_model/);
      });
    }
  }
});

describe("routing configuration sources", () => {
  it("rejects project profiles before they can replace a user profile and its endpoint opt-in", () => {
    const result = loadSources({
      accessProfiles: { work: { ...profile, credential: { kind: "native-oauth", authFile: "/synthetic/other-auth.json" },
        baseUrl: "https://relay.example", allowInsecureBaseUrl: true } },
    }, trusted);
    assert.ok(!result.ok, "project profiles must fail the load");
    assert.match(result.error.message, /accessProfiles/);
    assert.ok(result.error.message.includes(projectPath));
    assert.match(result.error.message, /user configuration.*SUBSWITCH_CONFIG/);
  });

  it("rejects project routes that refer to user profiles", () => {
    const result = loadSources({ routes: { project: route } }, trusted);
    assert.ok(!result.ok, "project routes must fail the load");
    assert.match(result.error.message, /routes/);
    assert.ok(result.error.message.includes(projectPath));
  });

  it("rejects project profile endpoint opt-ins without a user configuration", () => {
    const result = loadSources({ configVersion: 2, accessProfiles: {
      work: { ...profile, baseUrl: "https://relay.example", allowInsecureBaseUrl: true },
    } }, undefined, { globalConfigPath: false });
    assert.ok(!result.ok, "project profiles must fail even without a user file");
    assert.match(result.error.message, /accessProfiles/);
  });

  for (const key of ["accessProfiles", "routes"]) {
    for (const value of [{}, null]) {
      it(`rejects the project key ${key} even when its value is ${JSON.stringify(value)}`, () => {
        const result = loadSources({ [key]: value });
        assert.ok(!result.ok);
        assert.match(result.error.message, /not allowed in project configuration/);
        assert.ok(result.error.message.includes(key));
      });
    }
  }

  it("preserves user profiles, routes and endpoint opt-ins while other project settings merge", () => {
    const work = { ...profile, baseUrl: "https://relay.example", allowInsecureBaseUrl: true };
    const result = loadSources({ port: 4567, logLevel: "debug" }, { ...trusted, accessProfiles: { work } });
    assert.ok(result.ok);
    assert.deepEqual(result.value.config.accessProfiles, { work });
    assert.equal(result.value.config.routes?.work?.primary.profile, "work");
    assert.equal(result.value.config.port, 4567);
    assert.equal(result.value.config.logLevel, "debug");
  });

  for (const selection of [{ configPath: projectPath }, { env: { SUBSWITCH_CONFIG: projectPath } }]) {
    it(`accepts profiles and routes from explicit selection ${Object.keys(selection)[0]}`, () => {
      const result = loadSources({ ...trusted, port: 4567 }, undefined, selection);
      assert.ok(result.ok);
      assert.deepEqual(result.value.config.accessProfiles, trusted.accessProfiles);
      assert.equal(result.value.config.routes?.work?.primary.profile, "work");
      assert.equal(result.value.config.port, 4567);
      assert.deepEqual(result.value.configPaths, [projectPath]);
    });
  }

  it("still rejects a user endpoint without its opt-in", () => {
    const result = loadSources({}, { ...trusted, accessProfiles: {
      work: { ...profile, baseUrl: "https://relay.example" },
    } });
    assert.ok(!result.ok);
    assert.match(result.error.message, /endpoint_host_opt_in_required/);
  });
});
