import assert from "node:assert/strict";
import { chmod, mkdtemp, readdir, readFile, rm, stat, symlink, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it, type TestContext } from "node:test";
import { createConsoleLogger } from "../../src/logger.js";
import { createRelayLogger, writeFatalLineSync, writeStopLineSync } from "../../src/relay-log.js";

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z /;

async function privateDir(t: TestContext): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "subswitch-relay-log-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

async function logLines(directory: string): Promise<string[]> {
  const text = await readFile(join(directory, "relay.log"), "utf8");
  assert.ok(text.endsWith("\n"));
  return text.trimEnd().split("\n").map((line) => {
    assert.match(line, ISO);
    return line.replace(ISO, "");
  });
}

it("writes plain ISO lines with the same tokens as stderr", async (t) => {
  const directory = await privateDir(t);
  const lines: string[] = [];
  const { logger, flush } = createRelayLogger({ directory, mode: "foreground", minLevel: "info", console: createConsoleLogger("info", (line) => lines.push(line), false) });
  logger.log("debug", "omit");
  logger.log("info", "relay\u001b started", { path: "x\ny z", pid: 42 });
  await flush();

  const expected = ['level=info event="relay started" path="xy z" pid=42'];
  assert.deepEqual(lines, expected);
  assert.deepEqual(await logLines(directory), expected);
});

it("keeps detached request logs out of the console", async (t) => {
  const directory = await privateDir(t);
  const lines: string[] = [];
  const { logger, flush } = createRelayLogger({ directory, mode: "detach", minLevel: "info", console: createConsoleLogger("info", (line) => lines.push(line), false) });
  logger.log("info", "request_complete");
  await flush();

  assert.deepEqual(lines, []);
  assert.deepEqual(await logLines(directory), ["level=info event=request_complete"]);
});

it("uses the relay rotation names, cap and count", async (t) => {
  const directory = await privateDir(t);
  const active = join(directory, "relay.log");
  for (const suffix of ["", ".1", ".2", ".3"]) {
    await writeFile(join(directory, `relay${suffix}.log`), `old${suffix}`, { mode: 0o600 });
  }
  await truncate(active, 4 * 1024 * 1024);
  const { logger, flush } = createRelayLogger({ directory, mode: "detach", minLevel: "info" });
  logger.log("info", "next");
  await flush();

  assert.deepEqual((await readdir(directory)).sort(), ["relay.1.log", "relay.2.log", "relay.3.log", "relay.log"]);
  assert.equal((await stat(join(directory, "relay.1.log"))).size, 4 * 1024 * 1024);
  assert.equal(await readFile(join(directory, "relay.3.log"), "utf8"), "old.2");
  assert.deepEqual(await logLines(directory), ["level=info event=next"]);
});

it("batches the queue, caps UTF-8 bytes and prepends one counted drop notice", async (t) => {
  const writes: string[] = [];
  const { logger, flush } = createRelayLogger({
    directory: await privateDir(t), mode: "detach", minLevel: "info",
    append: async (_target, batch) => { writes.push(batch); },
  });
  const model = "é".repeat(65_000);
  logger.log("info", "first", { model });
  logger.log("info", "second", { model });
  logger.log("info", "third", { model });
  logger.log("info", "fourth", { model });
  await flush();
  logger.log("info", "next");
  await flush();

  assert.equal(writes.length, 2);
  const [notice, first, second, end] = (writes[0] ?? "").split("\n");
  assert.equal(notice?.replace(ISO, ""), "level=warn event=log_lines_dropped count=2");
  assert.match(first ?? "", / event=first model=/);
  assert.match(second ?? "", / event=second model=/);
  assert.equal(end, "");
  assert.ok(Buffer.byteLength(`${first}\n${second}\n`) <= 256 * 1024);
  assert.equal(writes[1]?.replace(ISO, ""), "level=info event=next\n");
});

it("serializes a new batch behind an active append and flushes both", async (t) => {
  const writes: string[] = [];
  let markStarted = (): void => assert.fail("start latch is not ready");
  let release = (): void => assert.fail("release latch is not ready");
  const firstStarted = new Promise<void>((resolve) => { markStarted = resolve; });
  const firstRelease = new Promise<void>((resolve) => { release = resolve; });
  const { logger, flush } = createRelayLogger({
    directory: await privateDir(t), mode: "detach", minLevel: "info",
    append: async (_target, batch) => {
      writes.push(batch.replace(ISO, ""));
      if (writes.length === 1) {
        markStarted();
        await firstRelease;
      }
    },
  });
  logger.log("info", "first");
  await firstStarted;
  logger.log("info", "second");
  logger.log("info", "third");
  await Promise.resolve();
  const beforeRelease = [...writes];
  release();
  await flush();

  assert.deepEqual(beforeRelease, ["level=info event=first\n"]);
  assert.equal(writes.length, 2);
  assert.match(writes[1] ?? "", /^level=info event=second\n.* level=info event=third\n$/);
});

it("warns once on stderr and reports pending drops in the next successful batch", async (t) => {
  const directory = await privateDir(t);
  const active = join(directory, "relay.log");
  const stderr: string[] = [];
  await writeFile(active, "keep", { mode: 0o600 });
  await chmod(active, 0o644);
  const { logger, flush } = createRelayLogger({ directory, mode: "detach", minLevel: "info", writeStderr: (line) => stderr.push(line) });
  logger.log("info", "first");
  logger.log("info", "too_big", { model: "x".repeat(256 * 1024) });
  await flush();
  logger.log("info", "second");
  await flush();

  assert.equal(await readFile(active, "utf8"), "keep");
  assert.deepEqual(stderr, ["subswitch: relay log unavailable\n"]);
  await truncate(active, 0);
  await chmod(active, 0o600);
  logger.log("info", "third");
  await flush();
  assert.deepEqual(await logLines(directory), ["level=warn event=log_lines_dropped count=1", "level=info event=third"]);
});

it("still writes the file when the foreground console throws", async (t) => {
  const directory = await privateDir(t);
  const { logger, flush } = createRelayLogger({
    directory, mode: "foreground", minLevel: "info",
    console: { log: () => { throw new Error("console unavailable"); } },
  });

  assert.doesNotThrow(() => logger.log("info", "keep"));
  await flush();
  assert.deepEqual(await logLines(directory), ["level=info event=keep"]);
});

it("writes fixed fatal and stop lines in order without a signal on crash", async (t) => {
  const directory = await privateDir(t);
  writeFatalLineSync(directory, 42);
  writeStopLineSync(directory, { pid: 42, exitCode: 1 });

  assert.deepEqual(await logLines(directory), ["level=error event=relay_fatal pid=42", "level=info event=relay_stopped pid=42 exitCode=1"]);
});

it("writes the signal and exit code on a normal stop", async (t) => {
  const directory = await privateDir(t);
  writeStopLineSync(directory, { pid: 42, exitCode: 0, signal: "SIGHUP" });

  assert.deepEqual(await logLines(directory), ["level=info event=relay_stopped pid=42 signal=SIGHUP exitCode=0"]);
});

it("leaves a symlink or loosely moded log intact and never throws", async (t) => {
  const directory = await privateDir(t);
  const target = join(directory, "target");
  const active = join(directory, "relay.log");
  await writeFile(target, "keep", { mode: 0o600 });
  await symlink(target, active);

  for (const path of [target, active]) {
    assert.doesNotThrow(() => writeFatalLineSync(directory, 42));
    assert.doesNotThrow(() => writeStopLineSync(directory, { pid: 42, exitCode: 1 }));
    assert.equal(await readFile(path, "utf8"), "keep");
    await rm(active);
    if (path === target) {
      await writeFile(active, "keep", { mode: 0o600 });
      await chmod(active, 0o644);
    }
  }
});
