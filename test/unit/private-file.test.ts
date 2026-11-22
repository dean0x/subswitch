import assert from "node:assert/strict";
import { chmod, link, mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it, type TestContext } from "node:test";
import { recordLimitFailure } from "../../src/limit-observation.js";
import { LimitRecorder, readLimitObservations, withLimitRecorder } from "../../src/limit-recorder.js";
import { noopLogger } from "../../src/logger.js";
import { appendPrivateLineSync, appendRotatingPrivateFile } from "../../src/private-file.js";
import { sampleLimitKey } from "../fixtures/limit-context.js";

const MIB = 1024 * 1024;
const relay = { stem: "relay", extension: "log", maxBytes: 4 * MIB, fileCount: 4 };
const limits = { stem: "events", extension: "jsonl", maxBytes: 2 * MIB, fileCount: 4 };

async function tempDir(t: TestContext): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "subswitch-private-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

async function recordLimit(directory: string): Promise<void> {
  const recorder = new LimitRecorder(directory, noopLogger);
  recordLimitFailure(withLimitRecorder(noopLogger, recorder), sampleLimitKey, {
    transport: "http", status: 429, committed: false,
  });
  await recorder.flush();
}

it("rotates a limit file one byte over the cap and keeps the read cap", async (t) => {
  const directory = await tempDir(t);
  const active = join(directory, "events.jsonl");
  await writeFile(active, "old\n", { mode: 0o600 });
  await truncate(active, 2 * MIB + 1);

  await recordLimit(directory);

  assert.deepEqual((await readdir(directory)).sort(), ["events.1.jsonl", "events.jsonl"]);
  assert.equal((await stat(join(directory, "events.1.jsonl"))).size, 2 * MIB + 1);
  assert.match(await readFile(active, "utf8"), /"status":429/);
  await assert.rejects(readLimitObservations(directory), /unsafe_limit_file/);
});

it("rotates a relay file one byte over the cap", async (t) => {
  const directory = await tempDir(t);
  const active = join(directory, "relay.log");
  await writeFile(active, "old\n", { mode: 0o600 });
  await truncate(active, 4 * MIB + 1);

  await appendRotatingPrivateFile({ ...relay, directory }, "new\n");

  assert.equal(await readFile(active, "utf8"), "new\n");
  assert.equal((await stat(join(directory, "relay.1.log"))).size, 4 * MIB + 1);
});

it("keeps the newest four files under the relay and limit caps", async (t) => {
  const root = await tempDir(t);
  for (const [config, filename, maxBytes] of [
    [relay, "relay", 4 * MIB], [limits, "events", 2 * MIB],
  ] as const) {
    const directory = join(root, filename);
    const extension = config.extension;
    const active = join(directory, `${filename}.${extension}`);
    await mkdir(directory, { mode: 0o700 });
    for (const suffix of ["", ".1", ".2", ".3"]) {
      await writeFile(join(directory, `${filename}${suffix}.${extension}`), `old${suffix}`, { mode: 0o600 });
    }
    await truncate(active, maxBytes);

    if (filename === "relay") await appendRotatingPrivateFile({ ...config, directory }, "next\n");
    else await recordLimit(directory);

    assert.deepEqual((await readdir(directory)).sort(), [".1", ".2", ".3", ""].map((suffix) => `${filename}${suffix}.${extension}`));
    assert.equal((await stat(join(directory, `${filename}.1.${extension}`))).size, maxBytes);
    assert.equal(await readFile(join(directory, `${filename}.3.${extension}`), "utf8"), "old.2");
    assert.equal((await stat(active)).mode & 0o777, 0o600);
    assert.ok((await stat(active)).size < maxBytes);
  }
});

it("refuses unsafe files for both log names and for the synchronous append", async (t) => {
  const root = await tempDir(t);
  const target = join(root, "target");
  await writeFile(target, "keep", { mode: 0o600 });
  const cases = [
    { name: "symlink", setUp: (path: string) => symlink(target, path) },
    { name: "hard link", setUp: (path: string) => link(target, path) },
    { name: "loose mode", setUp: async (path: string) => { await writeFile(path, "keep"); await chmod(path, 0o644); } },
    { name: "non-regular file", setUp: (path: string) => mkdir(path, { mode: 0o700 }) },
  ];
  for (const config of [relay, limits]) {
    for (const { name, setUp } of cases) {
      const directory = join(root, `${config.stem}-${name}`);
      await mkdir(directory, { mode: 0o700 });
      const active = join(directory, `${config.stem}.${config.extension}`);
      await setUp(active);

      const file = { ...config, directory };
      await assert.rejects(appendRotatingPrivateFile(file, "new\n"), name);
      assert.equal(appendPrivateLineSync(file, "exit\n").ok, false, name);
      if (name === "loose mode") assert.equal(await readFile(active, "utf8"), "keep");
    }
  }
  assert.equal(await readFile(target, "utf8"), "keep");
});

it("refuses a non-private folder and a folder symlink", async (t) => {
  const root = await tempDir(t);
  const loose = join(root, "loose");
  const linked = join(root, "linked");
  const target = join(root, "private");
  await mkdir(loose, { mode: 0o700 });
  await chmod(loose, 0o755);
  await mkdir(target, { mode: 0o700 });
  await symlink(target, linked);

  for (const config of [relay, limits]) {
    for (const directory of [loose, linked]) {
      const file = { ...config, directory };
      await assert.rejects(appendRotatingPrivateFile(file, "new\n"));
      assert.equal(appendPrivateLineSync(file, "exit\n").ok, false);
      assert.deepEqual(await readdir(directory), []);
    }
  }
});

it("refuses an unsafe rotation slot before it moves any file", async (t) => {
  const directory = await tempDir(t);
  const active = join(directory, "relay.log");
  await writeFile(active, "keep", { mode: 0o600 });
  await truncate(active, 4 * MIB);
  await symlink(active, join(directory, "relay.1.log"));

  await assert.rejects(appendRotatingPrivateFile({ ...relay, directory }, "new\n"));

  assert.deepEqual((await readdir(directory)).sort(), ["relay.1.log", "relay.log"]);
  assert.equal((await stat(active)).size, 4 * MIB);
});

it("appends a stop line synchronously to a private file", async (t) => {
  const directory = await tempDir(t);
  const file = { ...relay, directory };

  assert.equal(appendPrivateLineSync(file, "first\n").ok, true);
  assert.equal(appendPrivateLineSync(file, "second\n").ok, true);

  const active = join(directory, "relay.log");
  assert.equal(await readFile(active, "utf8"), "first\nsecond\n");
  assert.equal((await stat(active)).mode & 0o777, 0o600);
});
