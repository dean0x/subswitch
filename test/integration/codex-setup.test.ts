import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile, readFile, rm, access } from "node:fs/promises";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { cliChildCommand, cliChildFolders } from "../helpers/cli-child.js";

const exec = promisify(execFile);
describe("Codex setup CLI", () => {
  it("previews without writes, configures both clients, and preserves unrelated settings", async () => {
    const folders = await cliChildFolders();
    const temp = folders.home;
    const project = join(temp, "project"), codex = join(temp, "codex"), xdg = folders.configHome;
    await mkdir(join(project, ".claude"), { recursive: true }); await mkdir(codex);
    const original = '# Native settings\nmodel = "gpt-6-astra"\ndeveloper_instructions = "do-not-print-this-fixture"\n';
    await writeFile(join(codex, "config.toml"), original);
    await writeFile(join(project, "subswitch.config.json"), '{"codexIngress":{"enabled":false,"claude":{"enabled":false,"aliases":{"reviewer":"claude-opus-5"}}}}');
    await writeFile(join(project, ".claude", "settings.local.json"), '{"permissions":{"allow":["Read"]},"env":{"KEEP":"yes"}}');
    const run = (...args: string[]) => {
      const command = cliChildCommand(folders, args, { cwd: project, env: { CODEX_HOME: codex, SUBSWITCH_CONFIG: "", FORCE_COLOR: "0" } });
      return exec(command.file, command.args, { cwd: command.cwd, env: command.env, timeout: 10000 });
    };
    try {
      const preview = await run("init", "--client", "both", "--dry-run");
      assert.match(preview.stdout, /No files written/); assert.ok(!preview.stdout.includes("do-not-print-this-fixture"));
      assert.equal(await readFile(join(codex, "config.toml"), "utf8"), original);
      await assert.rejects(access(join(xdg, "subswitch", "config.json")));
      await assert.rejects(run("init", "--client", "codex"), error => !!(error as { stderr?: string }).stderr?.includes("--yes"));
      await run("init", "--client", "all", "--yes");
      const native = await readFile(join(codex, "config.toml"), "utf8");
      assert.match(native, /openai_base_url = "http:\/\/127.0.0.1:4141\/codex\/backend-api\/codex"/);
      assert.ok(native.includes(original));
      const settings = JSON.parse(await readFile(join(project, ".claude", "settings.local.json"), "utf8"));
      assert.deepEqual(settings.permissions, { allow: ["Read"] }); assert.equal(settings.env.KEEP, "yes"); assert.equal(settings.env.ANTHROPIC_BASE_URL, "http://127.0.0.1:4141");
      const models = JSON.parse((await run("models", "--client", "codex", "--json")).stdout);
      assert.equal(models.enabled, true); assert.ok(models.models.some((model: { aliases: string[] }) => model.aliases.includes("reviewer")));
      const allModels = JSON.parse((await run("models", "--client", "all", "--json")).stdout);
      const legacyModels = JSON.parse((await run("models", "--client", "both", "--json")).stdout);
      assert.deepEqual(allModels, legacyModels);
      assert.equal(allModels.client, "all");
      assert.deepEqual(Object.keys(allModels.clients), ["claude-code", "codex"]);
      await run("init", "--client", "both", "--yes");
      assert.equal(await readFile(join(codex, "config.toml"), "utf8"), native);
    } finally { await rm(temp, { recursive: true, force: true }); }
  });
});
