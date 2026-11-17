import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it, type TestContext } from "node:test";
import {
  actionControlPath,
  publishActionControl,
  readActionControl,
} from "../../src/routing/action-control.js";
import { RoutingError } from "../../src/routing/routing-types.js";

const port = 3210;
const capability = "a".repeat(64);
const replacementCapability = "b".repeat(64);
const validControl = { schemaVersion: 1, port, capability, pid: process.pid };

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), "subswitch-action-control-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return {
    root,
    directory: join(root, String(port)),
    path: join(root, String(port), "control.json"),
  };
}

async function controlFixture(t: TestContext, value: unknown = validControl) {
  const rig = await fixture(t);
  await mkdir(rig.directory, { mode: 0o700 });
  await writeFile(rig.path, JSON.stringify(value), { mode: 0o600 });
  return rig;
}

function refusal(code: string): (error: unknown) => boolean {
  return (error) =>
    error instanceof RoutingError && error.code === code && error.status === 503;
}

it("places the control file under the supplied actions directory", async (t) => {
  const { root, path } = await fixture(t);
  assert.equal(actionControlPath(port, root), path);
});

it("publishes and reads a private control file in the supplied directory", async (t) => {
  const { root, directory, path } = await fixture(t);
  await publishActionControl(port, capability, root);
  assert.deepEqual(await readActionControl(port, root), { port, capability });
  assert.deepEqual(JSON.parse(await readFile(path, "utf8")), validControl);
  assert.equal((await lstat(directory)).mode & 0o777, 0o700);
  assert.equal((await lstat(path)).mode & 0o777, 0o600);
  assert.deepEqual(await readdir(directory), ["control.json"]);
});

it("returns no control when the file is absent", async (t) => {
  const { root } = await fixture(t);
  assert.equal(await readActionControl(port, root), undefined);
});

it("refuses to publish when the port directory is a file", async (t) => {
  const { root, directory } = await fixture(t);
  await writeFile(directory, "not a directory", { mode: 0o600 });
  await assert.rejects(publishActionControl(port, capability, root), { code: "EEXIST" });
  assert.equal(await readFile(directory, "utf8"), "not a directory");
});

it("refuses to publish through a symbolic port directory", async (t) => {
  const { root, directory } = await fixture(t);
  const target = join(root, "target");
  await mkdir(target, { mode: 0o700 });
  await symlink(target, directory);
  await assert.rejects(
    publishActionControl(port, capability, root),
    refusal("action_control_directory_not_private"),
  );
  assert.deepEqual(await readdir(target), []);
});

for (const mode of [0o750, 0o705, 0o755]) {
  it(`refuses to publish in a port directory with mode ${mode.toString(8)}`, async (t) => {
    const { root, directory } = await fixture(t);
    await mkdir(directory, { mode: 0o700 });
    await chmod(directory, mode);
    await assert.rejects(
      publishActionControl(port, capability, root),
      refusal("action_control_directory_not_private"),
    );
    assert.deepEqual(await readdir(directory), []);
  });
}

it("refuses to publish in a port directory owned by another user", async (t) => {
  const { root, directory } = await fixture(t);
  await mkdir(directory, { mode: 0o700 });
  const { uid } = await lstat(directory);
  t.mock.method(process, "getuid", () => uid + 1, {});
  await assert.rejects(
    publishActionControl(port, capability, root),
    refusal("action_control_directory_not_private"),
  );
  assert.deepEqual(await readdir(directory), []);
});

it("refuses a directory in place of the control file", async (t) => {
  const { root, path } = await fixture(t);
  await mkdir(path, { recursive: true, mode: 0o700 });
  await assert.rejects(
    readActionControl(port, root),
    refusal("action_control_file_not_private"),
  );
});

it("refuses a symbolic control file", async (t) => {
  const { root, directory, path } = await fixture(t);
  const target = join(root, "target.json");
  await mkdir(directory, { mode: 0o700 });
  await writeFile(target, JSON.stringify(validControl), { mode: 0o600 });
  await symlink(target, path);
  await assert.rejects(
    readActionControl(port, root),
    refusal("action_control_file_not_private"),
  );
});

for (const mode of [0o640, 0o604]) {
  it(`refuses a control file with mode ${mode.toString(8)}`, async (t) => {
    const { root, path } = await controlFixture(t);
    await chmod(path, mode);
    await assert.rejects(
      readActionControl(port, root),
      refusal("action_control_file_not_private"),
    );
  });
}

it("refuses a control file owned by another user", async (t) => {
  const { root, path } = await controlFixture(t);
  const { uid } = await lstat(path);
  t.mock.method(process, "getuid", () => uid + 1, {});
  await assert.rejects(
    readActionControl(port, root),
    refusal("action_control_file_not_private"),
  );
});

it("refuses a control file larger than 4096 bytes", async (t) => {
  const { root, path } = await controlFixture(t);
  await writeFile(path, JSON.stringify(validControl).padEnd(4097, " "));
  await assert.rejects(
    readActionControl(port, root),
    refusal("action_control_file_not_private"),
  );
});

it("accepts a control file at the 4096-byte limit", async (t) => {
  const { root, path } = await controlFixture(t);
  await writeFile(path, JSON.stringify(validControl).padEnd(4096, " "));
  assert.deepEqual(await readActionControl(port, root), { port, capability });
});

const invalidValues: ReadonlyArray<readonly [string, unknown]> = [
  ["a different port", { ...validControl, port: port + 1 }],
  ["a non-string capability", { ...validControl, capability: 42 }],
  ["a 63-character capability", { ...validControl, capability: "a".repeat(63) }],
  ["a non-hexadecimal capability", { ...validControl, capability: "g".repeat(64) }],
  ["a non-number pid", { ...validControl, pid: String(process.pid) }],
  ["a fractional pid", { ...validControl, pid: 1.5 }],
  ["an unsafe integer pid", { ...validControl, pid: Number.MAX_SAFE_INTEGER + 1 }],
  ["a zero pid", { ...validControl, pid: 0 }],
  ["a negative pid", { ...validControl, pid: -1 }],
];
for (const [name, value] of invalidValues) {
  it(`refuses ${name}`, async (t) => {
    const { root } = await controlFixture(t, value);
    await assert.rejects(
      readActionControl(port, root),
      refusal("invalid_action_control_file"),
    );
  });
}

it("refuses malformed JSON", async (t) => {
  const { root, path } = await controlFixture(t);
  await writeFile(path, "{");
  await assert.rejects(readActionControl(port, root), SyntaxError);
});

it("returns no control for an exited owner process", async (t) => {
  const child = spawnSync(process.execPath, ["-e", ""], { timeout: 5000 });
  assert.equal(child.status, 0);
  const { root } = await controlFixture(t, { ...validControl, pid: child.pid });
  assert.equal(await readActionControl(port, root), undefined);
});

it("refuses control when the owner process check fails", async (t) => {
  const { root } = await controlFixture(t);
  t.mock.method(process, "kill", () => {
    throw Object.assign(new Error("fixture"), { code: "EPERM" });
  });
  await assert.rejects(
    readActionControl(port, root),
    refusal("action_control_owner_unavailable"),
  );
});

it("propagates file lookup errors other than a missing file", async (t) => {
  const { root, directory } = await fixture(t);
  await symlink(directory, directory);
  await assert.rejects(readActionControl(port, root), { code: "ELOOP" });
});

it("cleanup removes its own control file in the supplied directory", async (t) => {
  const { root, directory } = await fixture(t);
  const cleanup = await publishActionControl(port, capability, root);
  await cleanup();
  assert.equal(await readActionControl(port, root), undefined);
  assert.deepEqual(await readdir(directory), []);
});

it("cleanup preserves a replacement control file", async (t) => {
  const { root } = await fixture(t);
  const cleanup = await publishActionControl(port, capability, root);
  await publishActionControl(port, replacementCapability, root);
  await cleanup();
  assert.deepEqual(await readActionControl(port, root), {
    port,
    capability: replacementCapability,
  });
});

it("cleanup accepts an already removed control file", async (t) => {
  const { root, path } = await fixture(t);
  const cleanup = await publishActionControl(port, capability, root);
  await rm(path);
  await cleanup();
  assert.equal(await readActionControl(port, root), undefined);
});

it("cleanup preserves a control file that fails its privacy check", async (t) => {
  const { root, directory, path } = await fixture(t);
  const cleanup = await publishActionControl(port, capability, root);
  await chmod(path, 0o644);
  await cleanup();
  assert.deepEqual(await readdir(directory), ["control.json"]);
  assert.deepEqual(JSON.parse(await readFile(path, "utf8")), validControl);
});

it("removes temporary files when publication fails", async (t) => {
  const { root, directory, path } = await fixture(t);
  await mkdir(path, { recursive: true, mode: 0o700 });
  await assert.rejects(publishActionControl(port, capability, root), { code: "EISDIR" });
  assert.deepEqual(await readdir(directory), ["control.json"]);
});
