import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const cli = fileURLToPath(new URL("../../src/cli.ts", import.meta.url));
const tsx = fileURLToPath(new URL("../../node_modules/.bin/tsx", import.meta.url));

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "routing-config-trust-"));
  const userPath = join(root, "config", "subswitch", "config.json");
  await mkdir(join(userPath, ".."), { recursive: true });
  return { root, userPath, env: { PATH: process.env.PATH, HOME: root, XDG_CONFIG_HOME: join(root, "config") } };
}

function run(root: string, env: NodeJS.ProcessEnv, args: string[]) {
  return new Promise<{ code: number; stdout: string; stderr: string }>(resolve => {
    execFile(tsx, [cli, ...args], { cwd: root, env, timeout: 10_000, maxBuffer: 64 * 1024 },
      (error, stdout, stderr) => resolve({ code: error ? Number(error.code) || 1 : 0, stdout, stderr }));
  });
}

async function writeControl(root: string, port: number, value: unknown) {
  const path = join(root, ".cache", "subswitch", "actions", String(port), "control.json");
  await mkdir(join(path, ".."), { recursive: true, mode: 0o700 });
  await writeFile(path, JSON.stringify(value), { mode: 0o600 });
}

const native = ["run-action", "--client", "claude-code", "--", process.execPath, "--version"];

describe("CLI routing configuration sources", () => {
  for (const source of ["user", "explicit"] as const) {
    it(`uses the ${source} port for run-action instead of the project port`, { timeout: 15_000 }, async () => {
      const f = await fixture();
      try {
        await writeFile(f.userPath, '{"port":65533}');
        await writeFile(join(f.root, "subswitch.config.json"), '{"port":65534}');
        // Invalid metadata pins the selected port and must stop the native command.
        await writeControl(f.root, 65533, {});
        const result = await run(f.root, { ...f.env, ...(source === "explicit" ? { SUBSWITCH_CONFIG: f.userPath } : {}) }, native);
        assert.equal(result.code, 1);
        assert.match(result.stderr, /invalid_action_control_file/);
        assert.equal(result.stdout, "");
      } finally { await rm(f.root, { recursive: true, force: true }); }
    });
  }

  it("ignores the project port for run-action when the user file is absent", { timeout: 15_000 }, async () => {
    const f = await fixture();
    try {
      await writeFile(join(f.root, "subswitch.config.json"), '{"port":65534}');
      await writeControl(f.root, 65534, {});
      const result = await run(f.root, f.env, native);
      assert.equal(result.code, 0, result.stderr);
      assert.match(result.stdout, /v\d+\./);
    } finally { await rm(f.root, { recursive: true, force: true }); }
  });

  it("reports project routes before it starts a native command", { timeout: 15_000 }, async () => {
    const f = await fixture();
    try {
      await writeFile(join(f.root, "subswitch.config.json"), '{"routes":{}}');
      const result = await run(f.root, f.env, native);
      assert.equal(result.code, 1);
      assert.match(result.stderr, /routes.*not allowed in project configuration/);
      assert.equal(result.stdout, "");
    } finally { await rm(f.root, { recursive: true, force: true }); }
  });
});
