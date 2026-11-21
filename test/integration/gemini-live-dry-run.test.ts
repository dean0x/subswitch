import assert from "node:assert/strict";
import { lstatSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { mkdtemp, readFile, readdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";

it("TP-47/48: attaches to the fake Gemini route and records its cancel and cleanup", async (t) => {
  const pkg: unknown = JSON.parse(await readFile(new URL("../../package.json", import.meta.url), "utf8"));
  assert.ok(pkg !== null && typeof pkg === "object" && "scripts" in pkg && pkg.scripts !== null && typeof pkg.scripts === "object");
  assert.ok("probe:gemini" in pkg.scripts, "The dry-run command must exist");
  const { main, runDryCheck, checkEvidence } = await import("../../e2e/gates/gemini-live-check.js");
  const root = await mkdtemp(join(await realpath(tmpdir()), "subswitch-gemini-evidence-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  const transport = globalThis.fetch;
  let offLoopback = 0;
  const loopbackFetch: typeof fetch = async (input, init) => {
    const destination = new URL(input instanceof Request ? input.url : input);
    if (destination.hostname !== "127.0.0.1") {
      offLoopback += 1;
      throw new Error("The dry run must not leave loopback");
    }
    return transport(input, { ...init, redirect: "error" });
  };
  t.mock.method(globalThis, "fetch", loopbackFetch);
  let clientFolder: string | undefined;
  const lines: string[] = [];
  const out = (line: string) => {
    lines.push(line);
    const prefix = "Client folder: ";
    if (!line.startsWith(prefix)) return;
    clientFolder = line.slice(prefix.length);
    assert.deepEqual(readdirSync(clientFolder), ["package.json"]);
    const userConfigDir = join(clientFolder, "..", "home", ".config", "subswitch");
    assert.throws(() => lstatSync(join(userConfigDir, "config.json")), { code: "ENOENT" });
    // Without the explicit dry-run config, run-action would read this invalid fixture and fail to attach.
    mkdirSync(userConfigDir, { recursive: true, mode: 0o700 });
    writeFileSync(join(userConfigDir, "config.json"), "not JSON", { mode: 0o600, flag: "wx" });
  };
  const code = await main(["--dry-run", "--evidence-root", root], {
    env: { CI: "true" }, stdinIsTTY: false, stdoutIsTTY: false,
    ask: async () => assert.fail("The dry run must not prompt"), out,
    dryRun: (args) => runDryCheck(args, out),
  });
  assert.equal(code, 0, lines.at(-1));
  assert.equal(offLoopback, 0);
  assert.ok(clientFolder);
  assert.throws(() => lstatSync(clientFolder ?? ""), { code: "ENOENT" });
  const dirs = await readdir(root);
  assert.equal(dirs.length, 1);
  const report: unknown = JSON.parse(await readFile(join(root, dirs[0] ?? "", "report.json"), "utf8"));
  assert.equal(checkEvidence(report), true);
  assert.deepEqual(report, {
    schemaVersion: 1, mode: "dry-run", success: true, code: null,
    counts: { probe: { load: 1, generate: 2, output: 32, thinking: 0 }, session: { load: 0, generate: 2, output: 64, thinking: 0 }, cancel: 1 },
    probeStatus: "2xx", actionRequests: 2, controlPublished: true, controlRemoved: true, cancelled: true,
  });
});
