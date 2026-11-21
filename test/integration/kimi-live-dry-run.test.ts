import assert from "node:assert/strict";
import { readFileSync, readdirSync, realpathSync, renameSync } from "node:fs";
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { it, type TestContext } from "node:test";
import { checkEvidence, main, runCheck } from "../../e2e/gates/kimi-live-check.js";
import { isPlainObject } from "../../src/plain-object.js";

const evidenceRoot = async (t: TestContext): Promise<string> => {
  const root = await mkdtemp(join(await realpath(tmpdir()), "subswitch-kimi-evidence-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
};

const runDry = async (t: TestContext, root: string, onClientFolder?: (folder: string) => void) => {
  const temp = join(root, "tmp");
  const evidence = join(root, "evidence");
  await mkdir(temp);
  await mkdir(evidence);
  const previousTemp = process.env["TMPDIR"];
  process.env["TMPDIR"] = temp;
  t.after(() => {
    if (previousTemp === undefined) delete process.env["TMPDIR"];
    else process.env["TMPDIR"] = previousTemp;
  });

  const fetchReal = globalThis.fetch;
  let refused = 0;
  const loopbackFetch: typeof fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input);
    if (url.hostname !== "127.0.0.1") {
      refused += 1;
      throw new Error("The dry run must use only the loopback host.");
    }
    return fetchReal(input, { ...init, redirect: "error" });
  };
  t.mock.method(globalThis, "fetch", loopbackFetch);
  const lines: string[] = [];
  const prefix = "Client folder: ";
  let clientFolder: string | undefined;
  const out = (line: string) => {
    lines.push(line);
    if (!line.startsWith(prefix)) return;
    clientFolder = realpathSync(line.slice(prefix.length));
    assert.ok(clientFolder.startsWith(`${temp}${sep}`), "The client folder must be below the temporary root.");
    onClientFolder?.(clientFolder);
  };
  const code = await main(["--dry-run", "--evidence-root", evidence], {
    env: { CI: "true" }, stdinIsTTY: false, stdoutIsTTY: false,
    ask: async () => assert.fail("The dry run must not ask for the live phrase."),
    out, run: (args) => runCheck(args, out),
  });
  assert.equal(refused, 0, "The dry run must not attempt a request off the loopback host.");
  return { code, evidence, lines, clientFolder };
};

const readReport = async (root: string): Promise<Record<string, unknown>> => {
  const folders = await readdir(root);
  assert.equal(folders.length, 1, "The dry run must write one evidence folder.");
  const [folder] = folders;
  assert.ok(folder);
  const report: unknown = JSON.parse(await readFile(join(root, folder, "report.json"), "utf8"));
  assert.equal(checkEvidence(report), true);
  assert.ok(isPlainObject(report));
  return report;
};

it("runs the dry check with only loopback traffic and writes evidence of Kimi use", async (t) => {
  const root = await evidenceRoot(t);
  const { code, evidence, lines } = await runDry(t, root);
  assert.equal(code, 0, lines.at(-1));
  const report = await readReport(evidence);
  assert.equal(report["success"], true);
  assert.ok(isPlainObject(report["caps"]) && isPlainObject(report["caps"]["used"]));
  const kimi = report["caps"]["used"]["kimi"];
  assert.ok(typeof kimi === "number" && kimi > 0, "The evidence must show that the dry run reached Kimi.");
  assert.equal(report["cooldownMs"], 0);
});

it("starts the fake client with only a copy of package.json and removes its folder", async (t) => {
  const root = await evidenceRoot(t);
  const { code, clientFolder, lines } = await runDry(t, root, (folder) => {
    assert.deepEqual(readdirSync(folder), ["package.json"]);
    assert.equal(readFileSync(join(folder, "package.json"), "utf8"),
      readFileSync(new URL("../../package.json", import.meta.url), "utf8"));
  });
  assert.equal(code, 0, lines.find((line) => line.startsWith("The dry-run command failed")) ?? lines.at(-1));
  assert.ok(clientFolder, "The check must create a temporary client folder.");
  await assert.rejects(lstat(clientFolder), { code: "ENOENT" });
});

it("removes the client folder when the fake client fails", async (t) => {
  const root = await evidenceRoot(t);
  const { code, clientFolder, evidence } = await runDry(t, root, (folder) => {
    renameSync(join(folder, "package.json"), join(folder, "package-unused.json"));
  });
  assert.ok(clientFolder, "The check must create a temporary client folder.");
  assert.equal(code, 1);
  assert.equal((await readReport(evidence))["failure"], "attach_failed");
  await assert.rejects(lstat(clientFolder), { code: "ENOENT" });
});
