import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs, { chmod, link, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { it, type TestContext } from "node:test";
import {
  CodexQuotaWriter, codexQuotaSnapshotPaths, isCodexQuotaSource, observeCodexQuota,
  parseCodexQuotaHeaders, serializeCodexQuota, writeCodexQuotaFile,
  type CodexQuotaSnapshot, type CodexQuotaParse, type CodexQuotaWriteResult, type QuotaHeaders,
} from "../../src/codex-quota-snapshot.js";
import { LimitRecorder, withLimitRecorder } from "../../src/limit-recorder.js";
import { recordLimitFailure, type LimitContext } from "../../src/limit-observation.js";
import type { Logger, LogFields } from "../../src/logger.js";

const SEC = 1800000000;
const context: LimitContext = { provider: "codex", product: "chatgpt-codex", protocol: "responses" };
const literal = '{"version":1,"observed_at":1800000000,"windows":[{"window_minutes":300,"used_percent":25,"resets_at":1800000600},{"window_minutes":10080,"used_percent":50,"resets_at":1800001200}],"rate_limit_reached_type":"weekly","source":"response-headers","plan_type":null,"active_limit":null,"limit_name":null,"credits":null,"additional_limits":[]}';
const fixedNames = [
  "x-codex-primary-used-percent", "x-codex-primary-window-minutes", "x-codex-primary-reset-at",
  "x-codex-secondary-used-percent", "x-codex-secondary-window-minutes", "x-codex-secondary-reset-at",
  "x-codex-rate-limit-reached-type", "x-codex-credits-has-credits", "x-codex-credits-unlimited",
  "x-codex-credits-balance", "x-codex-plan-type", "x-codex-active-limit", "x-codex-limit-name",
];
const values = (): Record<string, string> => ({
  "x-codex-primary-used-percent": "25", "x-codex-primary-window-minutes": "300",
  "x-codex-primary-reset-at": "1800000600", "x-codex-secondary-used-percent": "50",
  "x-codex-secondary-window-minutes": "10080", "x-codex-secondary-reset-at": "1800001200",
  "x-codex-rate-limit-reached-type": "weekly",
});
const headers = (extra: Record<string, string> = {}): Headers => new Headers({ ...values(), ...extra });
const parsed = (extra: Record<string, string> = {}): CodexQuotaParse => parseCodexQuotaHeaders(headers(extra), SEC);
function snapshot(extra: Partial<CodexQuotaSnapshot> = {}): CodexQuotaSnapshot {
  return { version: 1, observed_at: SEC, windows: [{ window_minutes: 300, used_percent: 25, resets_at: SEC + 600 }],
    rate_limit_reached_type: null, source: "response-headers", plan_type: null, active_limit: null,
    limit_name: null, credits: null, additional_limits: [], ...extra };
}
async function root(t: TestContext): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "subswitch-quota-"));
  t.after(() => rm(path, { recursive: true, force: true }));
  return path;
}
function logs() {
  const events: { event: string; fields?: LogFields }[] = [];
  const logger: Logger = { log: (_level, event, fields) => events.push({ event, ...(fields ? { fields } : {}) }) };
  return { events, logger };
}
function fakeWriter(options: { write?: (text: string) => Promise<CodexQuotaWriteResult>; logger?: Logger; now?: () => number } = {}) {
  const writes: string[] = [];
  const writer = new CodexQuotaWriter({ credentialFile: "/fixture/.codex/auth.json", now: options.now ?? (() => SEC * 1000),
    logger: options.logger ?? { log() {} }, write: options.write ?? (async (text) => { writes.push(text); return { ok: true }; }) });
  return { writer, writes };
}
function family(id: string, minutes = "300"): Record<string, string> {
  return { [`x-codex-${id}-primary-used-percent`]: "75", [`x-codex-${id}-primary-window-minutes`]: minutes,
    [`x-codex-${id}-primary-reset-at`]: "1800000300", [`x-codex-${id}-limit-name`]: "Extra limit" };
}
function raw(entries: [string, string][], onGet: (name: string) => void = () => {}): QuotaHeaders {
  return { get(name) { onGet(name); return entries.find(([key]) => key === name)?.[1] ?? null; }, entries: () => entries.values() };
}
async function disk(t: TestContext) {
  const home = await root(t), paths = codexQuotaSnapshotPaths(home)!;
  const { logger, events } = logs();
  const recorder = new LimitRecorder(join(home, "events"), logger, { codexQuota: { ...paths, now: () => SEC * 1000 + 999 } });
  return { ...paths, home, events, recorder, logger: withLimitRecorder(logger, recorder) };
}

it("TP-4 TP-31 maps slots into the exact ten-key literal contract", () => {
  assert.equal(serializeCodexQuota(parsed().snapshot!), literal);
});
it("TP-42 classifies a weekly primary and sorts reversed durations", () => {
  const weekly = values();
  delete weekly["x-codex-secondary-used-percent"];
  weekly["x-codex-primary-window-minutes"] = "10080";
  assert.deepEqual(parseCodexQuotaHeaders(new Headers(weekly), SEC).snapshot?.windows,
    [{ window_minutes: 10080, used_percent: 25, resets_at: 1800000600 }]);
  assert.deepEqual(parsed({ "x-codex-primary-window-minutes": "10080", "x-codex-secondary-window-minutes": "300" }).snapshot?.windows,
    [{ window_minutes: 300, used_percent: 50, resets_at: 1800001200 }, { window_minutes: 10080, used_percent: 25, resets_at: 1800000600 }]);
});
it("TP-6 TP-9 refuses other products and paths before any header access", async (t) => {
  const d = await disk(t);
  let accesses = 0;
  const h: QuotaHeaders = { get() { accesses++; return null; }, entries() { accesses++; return [][Symbol.iterator](); } };
  const others: LimitContext[] = [
    { ...context, provider: "claude", product: "claude-code" }, { ...context, provider: "kimi", product: "kimi-code" },
    { ...context, product: "openai-api" }, { ...context, provider: "kimi" },
  ];
  for (const c of others) observeCodexQuota(d.logger, c, d.credentialFile, h);
  observeCodexQuota(d.logger, context, join(d.home, "other.json"), h);
  await d.recorder.flush();
  assert.equal(accesses, 0);
  await assert.rejects(readFile(d.path), { code: "ENOENT" });
  observeCodexQuota(d.logger, context, d.credentialFile, headers());
  await d.recorder.flush();
  assert.equal(await readFile(d.path, "utf8").catch(() => "<missing>"), literal);
  assert.equal(isCodexQuotaSource(context, `${d.home}/x/../.codex/auth.json`, d.credentialFile), true);
});
it("TP-10 TP-44 preserves a good file for empty or non-codex windows", async (t) => {
  const d = await disk(t);
  observeCodexQuota(d.logger, context, d.credentialFile, headers());
  await d.recorder.flush();
  for (const h of [new Headers(), new Headers({ "x-codex-rate-limit-reached-type": "weekly" }),
    new Headers(family("extra")), new Headers({ "x-codex-credits-balance": "25", "x-codex-plan-type": "pro" })]) {
    observeCodexQuota(d.logger, context, d.credentialFile, h);
    await d.recorder.flush();
    assert.equal(await readFile(d.path, "utf8").catch(() => "<missing>"), literal);
  }
});
it("TP-11 drops every partial slot and keeps the other complete window", () => {
  for (const suffix of ["used-percent", "window-minutes", "reset-at"]) {
    const v = values(); delete v[`x-codex-primary-${suffix}`];
    assert.deepEqual(parseCodexQuotaHeaders(new Headers(v), SEC).snapshot?.windows,
      [{ window_minutes: 10080, used_percent: 50, resets_at: 1800001200 }]);
  }
});
it("TP-12 refuses malformed numeric text", () => {
  for (const bad of ["1".repeat(33), "50, 60", "-1", "1e2", "0x10", "", "NaN", "1.1234567", "1234567890123456"]) {
    for (const suffix of ["used-percent", "window-minutes", "reset-at"]) {
      assert.equal(parsed({ [`x-codex-primary-${suffix}`]: bad }).snapshot?.windows.length, 1, `${suffix}: ${bad}`);
    }
  }
});
it("TP-13 bounds window duration and clamps percentage", () => {
  for (const bad of ["0", "527041", "1.5"]) assert.equal(parsed({ "x-codex-primary-window-minutes": bad }).snapshot?.windows.length, 1);
  assert.equal(parsed({ "x-codex-primary-used-percent": "150" }).snapshot?.windows[0]?.used_percent, 100);
  assert.equal(parsed({ "x-codex-primary-window-minutes": "527040" }).snapshot?.windows[1]?.window_minutes, 527040);
});
it("TP-14 rejects out-of-range and millisecond resets with one fixed warning", async () => {
  const { logger, events } = logs(), { writer } = fakeWriter({ logger });
  for (const bad of ["1799999699", "1800018301", "1800000600000", "1800000600.5"]) {
    const p = parsed({ "x-codex-primary-reset-at": bad });
    assert.equal(p.resetRejected, true); assert.equal(p.snapshot?.windows.length, 1);
    writer.record(p); await writer.flush();
  }
  assert.deepEqual(events, [{ event: "codex_quota_reset_out_of_range", fields: { errorCode: "RESET_RANGE" } }]);
  for (const value of ["1799999700", "1800018300"]) assert.equal(parsed({ "x-codex-primary-reset-at": value }).snapshot?.windows.length, 2);
});
it("TP-15 keeps primary when both window durations match", () => {
  assert.deepEqual(parsed({ "x-codex-secondary-window-minutes": "300" }).snapshot?.windows,
    [{ window_minutes: 300, used_percent: 25, resets_at: 1800000600 }]);
});
it("TP-16 never defaults the recorder snapshot to HOME", async (t) => {
  const home = await root(t);
  const child = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-"], {
    cwd: join(import.meta.dirname, "../.."), env: { ...process.env, HOME: home, CODEX_HOME: join(home, "ignored") }, encoding: "utf8", timeout: 10000,
    input: `import assert from 'node:assert/strict';
      import { access } from 'node:fs/promises';
      import { LimitRecorder, withLimitRecorder } from './src/limit-recorder.ts';
      import { observeCodexQuota, isCodexQuotaSource, codexQuotaSnapshotPaths } from './src/codex-quota-snapshot.ts';
      const context = ${JSON.stringify(context)};
      assert.equal(isCodexQuotaSource(context, '~/.codex/auth.json', process.env.HOME + '/.codex/auth.json'), true);
      assert.equal(isCodexQuotaSource(context, process.env.HOME + '/.codex/auth.json', '~/.codex/auth.json'), true);
      assert.deepEqual(codexQuotaSnapshotPaths(process.env.HOME), {path: process.env.HOME + '/.cache/subswitch/codex-quota.json', credentialFile: process.env.HOME + '/.codex/auth.json'});
      const recorder = new LimitRecorder(process.env.HOME + '/events', {log(){}});
      observeCodexQuota(withLimitRecorder({log(){}}, recorder), ${JSON.stringify(context)}, process.env.HOME + '/.codex/auth.json', new Headers(${JSON.stringify(values())}));
      await recorder.flush();
      await assert.rejects(access(process.env.HOME + '/.cache/subswitch/codex-quota.json'), {code:'ENOENT'});
      assert.equal(recorder.codexQuota, undefined);`,
  });
  assert.equal(child.status, 0, child.stderr);
  await assert.rejects(readFile(join(home, ".cache/subswitch/codex-quota.json")), { code: "ENOENT" });
});
it("TP-17 returns only explicit absolute home paths without filesystem work", async (t) => {
  for (const home of ["", "relative", "~/relative"]) assert.equal(codexQuotaSnapshotPaths(home), undefined);
  const home = await root(t);
  assert.deepEqual(codexQuotaSnapshotPaths(home), { path: join(home, ".cache/subswitch/codex-quota.json"), credentialFile: join(home, ".codex/auth.json") });
  const recorder = new LimitRecorder(join(home, "events"), { log() {} }, { codexQuota: { path: "relative", credentialFile: "fixture" } });
  assert.equal(recorder.codexQuota, undefined);
  assert.deepEqual(await readdir(home), []);
});
it("TP-21 TP-25 creates private files only at first write and leaves no temporary file", async (t) => {
  const d = await disk(t);
  assert.deepEqual(await readdir(d.home), []);
  observeCodexQuota(d.logger, context, d.credentialFile, headers()); await d.recorder.flush();
  assert.equal(await readFile(d.path, "utf8").catch(() => "<missing>"), literal);
  const file = await lstat(d.path), directory = await lstat(dirname(d.path));
  assert.equal(file.isFile(), true); assert.equal(file.mode & 0o777, 0o600); assert.equal(file.nlink, 1);
  assert.equal(file.uid, process.getuid?.()); assert.equal(directory.uid, process.getuid?.());
  assert.equal(directory.mode & 0o777, 0o700);
  assert.deepEqual(await readdir(dirname(d.path)), ["codex-quota.json"]);
});
for (const kind of ["symlink", "hardlink"] as const) it(`TP-${kind === "symlink" ? 22 : 23} replaces a ${kind} without changing its target`, async (t) => {
  const home = await root(t), target = join(home, "target"), path = join(home, "codex-quota.json");
  await writeFile(target, "unchanged", { mode: 0o600 });
  if (kind === "symlink") await symlink(target, path); else await link(target, path);
  assert.deepEqual(await writeCodexQuotaFile(path, literal), { ok: true });
  assert.equal(await readFile(target, "utf8"), "unchanged");
  assert.equal((await lstat(path)).isSymbolicLink(), false); assert.equal((await lstat(path)).nlink, 1);
  assert.equal(await readFile(path, "utf8"), literal);
});
it("TP-24 refuses unsafe directories without a mode change", async (t) => {
  const home = await root(t);
  for (const mode of [0o755, 0o750]) {
    const directory = join(home, String(mode)); await mkdir(directory, { mode });
    assert.deepEqual(await writeCodexQuotaFile(join(directory, "codex-quota.json"), literal),
      { ok: false, code: "codex_quota_directory_unsafe", errorCode: "DIRECTORY_UNSAFE" });
    assert.equal((await lstat(directory)).mode & 0o777, mode); assert.deepEqual(await readdir(directory), []);
  }
  const target = join(home, "target"); await mkdir(target, { mode: 0o700 });
  const symbolic = join(home, "symbolic"); await symlink(target, symbolic);
  const file = join(home, "file"); await writeFile(file, "unchanged");
  for (const directory of [symbolic, file]) {
    const result = await writeCodexQuotaFile(join(directory, "codex-quota.json"), literal);
    assert.equal(result.ok, false); if (!result.ok) assert.equal(result.code, "codex_quota_directory_unsafe");
  }
  assert.deepEqual(await readdir(target), []); assert.equal(await readFile(file, "utf8"), "unchanged");
});
it("TP-24 refuses a snapshot directory owned by another user", async (t) => {
  const home = await root(t), uid = process.getuid!();
  t.mock.method(process, "getuid", () => uid + 1, {});
  assert.deepEqual(await writeCodexQuotaFile(join(home, "codex-quota.json"), literal),
    { ok: false, code: "codex_quota_directory_unsafe", errorCode: "DIRECTORY_UNSAFE" });
  assert.deepEqual(await readdir(home), []);
});
for (const unsafe of ["type", "links", "owner", "mode"] as const) it(`TP-21 refuses an unsafe temporary descriptor: ${unsafe}`, async (t) => {
  const home = await root(t), path = join(home, "codex-quota.json");
  await writeFile(path, "old");
  const originalOpen = fs.open;
  const mocked = t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
    const file = await originalOpen(...args), originalStat = file.stat.bind(file);
    t.mock.method(file, "stat", async () => {
      const stat = await originalStat();
      if (unsafe === "type") stat.isFile = () => false;
      if (unsafe === "links") stat.nlink = 2;
      if (unsafe === "owner") stat.uid++;
      if (unsafe === "mode") stat.mode |= 0o040;
      return stat;
    });
    return file;
  });
  syncBuiltinESMExports();
  try {
    assert.deepEqual(await writeCodexQuotaFile(path, literal), { ok: false, code: "codex_quota_unavailable", errorCode: "FILE_UNSAFE" });
    assert.equal(await readFile(path, "utf8"), "old");
    assert.deepEqual(await readdir(home), ["codex-quota.json"]);
  } finally { mocked.mock.restore(); syncBuiltinESMExports(); }
});
it("TP-26 preserves an existing temporary file when exclusive create fails", async (t) => {
  const home = await root(t), path = join(home, "codex-quota.json");
  let collision = "";
  const mocked = t.mock.method(fs, "open", async (temporary: Parameters<typeof fs.open>[0]) => {
    collision = String(temporary);
    await writeFile(collision, "other writer");
    throw Object.assign(new Error("fixture"), { code: "EEXIST" });
  });
  syncBuiltinESMExports();
  try {
    assert.deepEqual(await writeCodexQuotaFile(path, literal), { ok: false, code: "codex_quota_unavailable", errorCode: "EEXIST" });
    assert.equal(await readFile(collision, "utf8").catch(() => "<missing>"), "other writer");
    await assert.rejects(readFile(path), { code: "ENOENT" });
  } finally { mocked.mock.restore(); syncBuiltinESMExports(); }
});
it("TP-26 keeps an old file on write failure and cleans temporary files", async (t) => {
  const home = await root(t), path = join(home, "codex-quota.json");
  await mkdir(path, { mode: 0o700 }); await writeFile(join(path, "old"), "unchanged");
  const result = await writeCodexQuotaFile(path, literal);
  assert.equal(result.ok, false);
  assert.equal(await readFile(join(path, "old"), "utf8"), "unchanged");
  assert.deepEqual(await readdir(home), ["codex-quota.json"]);
  await chmod(home, 0o500);
  try {
    const failed = await writeCodexQuotaFile(join(home, "other.json"), literal);
    assert.equal(failed.ok, false);
  } finally { await chmod(home, 0o700); }
});
it("TP-30 keeps snapshot warnings fixed and separate from the events warning flag", async (t) => {
  for (const first of ["quota", "events"]) {
    const home = await root(t), { logger, events } = logs();
    const directory = join(home, "unsafe"); await mkdir(directory, { mode: 0o755 });
    const recorder = new LimitRecorder(directory, logger, { codexQuota: { path: join(directory, "codex-quota.json"), credentialFile: join(home, "auth.json"), now: () => SEC * 1000 } });
    const wrapped = withLimitRecorder(logger, recorder);
    const quota = () => observeCodexQuota(wrapped, context, join(home, "auth.json"), headers());
    const event = () => recordLimitFailure(wrapped, context, { transport: "http", committed: false, status: 429, text: "private" });
    if (first === "quota") { quota(); await recorder.flush(); event(); } else { event(); await recorder.flush(); quota(); }
    await recorder.flush(); quota(); await recorder.flush();
    assert.deepEqual(events.map((e) => e.event).sort(), ["codex_quota_directory_unsafe", "limit_recording_unavailable"]);
    assert.deepEqual(events.find((e) => e.event === "codex_quota_directory_unsafe")?.fields, { errorCode: "DIRECTORY_UNSAFE" });
    assert.ok(!JSON.stringify(events).includes(home));
  }
  for (const code of ["EACCES", "private/path\nvalue"]) {
    const { logger, events } = logs();
    const { writer } = fakeWriter({ logger, write: async () => ({ ok: false, code: "codex_quota_unavailable", errorCode: code }) });
    writer.record({ snapshot: snapshot(), resetRejected: false }); await writer.flush();
    assert.deepEqual(events, [{ event: "codex_quota_unavailable", fields: { errorCode: code === "EACCES" ? "EACCES" : "WRITE_FAILED" } }]);
  }
});
it("TP-32 TP-33 refuses hostile text and unrelated private headers", () => {
  for (const bad of ["\x1b[31m", "x\ry", "x\ny", "x\n", "unié", "x".repeat(10240)]) {
    const p = parseCodexQuotaHeaders(raw(Object.entries({ ...values(), "x-codex-rate-limit-reached-type": bad,
      "x-codex-active-limit": bad, "x-codex-plan-type": bad, "x-codex-limit-name": bad, "set-cookie": "private-cookie" })), SEC);
    assert.equal(p.snapshot?.rate_limit_reached_type, null); assert.equal(p.snapshot?.active_limit, null);
    assert.equal(p.snapshot?.plan_type, null); assert.equal(p.snapshot?.limit_name, null);
    assert.ok(!serializeCodexQuota(p.snapshot!)?.includes(bad)); assert.ok(!serializeCodexQuota(p.snapshot!)?.includes("private-cookie"));
  }
});
it("TP-34 captures hook floor seconds and activity before parse, and contains throws", () => {
  const records: CodexQuotaParse[] = [], steps: string[] = [];
  const logger: Logger = { log() {}, codexQuota: { credentialFile: "/fixture/auth.json", now: () => SEC * 1000 + 999,
    noteActivity() { steps.push("activity"); }, record(p) { records.push(p); } } };
  observeCodexQuota(logger, context, "/fixture/auth.json", raw(Object.entries({ ...values(), date: "Wed, 01 Jan 2000 00:00:00 GMT" }), () => steps.push("get")));
  assert.equal(records[0]?.snapshot?.observed_at, SEC); assert.equal(steps[0], "activity");
  assert.doesNotThrow(() => observeCodexQuota(logger, context, "/fixture/auth.json", { get() { throw Error("private"); }, entries() { throw Error("private"); } }));
  assert.doesNotThrow(() => observeCodexQuota(logger, context, "/fixture/auth.json", { get: headers().get.bind(headers()), entries() { throw Error("private"); } }));
  logger.codexQuota!.record = () => { throw Error("private"); };
  assert.doesNotThrow(() => observeCodexQuota(logger, context, "/fixture/auth.json", headers()));
});
it("TP-31 projects only contract keys from structurally wider values", () => {
  const wideWindow = { window_minutes: 300, used_percent: 25, resets_at: SEC + 600, private: "hidden" };
  const wide = { ...snapshot(), private: "hidden", windows: [wideWindow],
    credits: { has_credits: true, unlimited: false, balance: 1, private: "hidden" },
    additional_limits: [{ limit_id: "extra", limit_name: null, windows: [wideWindow], private: "hidden" }] };
  assert.equal(serializeCodexQuota(wide), '{"version":1,"observed_at":1800000000,"windows":[{"window_minutes":300,"used_percent":25,"resets_at":1800000600}],"rate_limit_reached_type":null,"source":"response-headers","plan_type":null,"active_limit":null,"limit_name":null,"credits":{"has_credits":true,"unlimited":false,"balance":1},"additional_limits":[{"limit_id":"extra","limit_name":null,"windows":[{"window_minutes":300,"used_percent":25,"resets_at":1800000600}]}]}');
});
it("TP-35 refuses oversized serialization before the write boundary", async () => {
  const { logger, events } = logs(), { writer, writes } = fakeWriter({ logger });
  const huge = snapshot({ additional_limits: Array.from({ length: 40 }, () => ({ limit_id: "extra", limit_name: "x".repeat(64), windows: snapshot().windows })) });
  assert.equal(serializeCodexQuota(huge), undefined);
  writer.record({ snapshot: huge, resetRejected: false }); await writer.flush();
  assert.deepEqual(writes, []); assert.deepEqual(events, [{ event: "codex_quota_dropped", fields: { errorCode: "SNAPSHOT_SIZE" } }]);
});
it("TP-36 TP-38 flushes the latest of 100 snapshots with at most two writes", async () => {
  const { logger, events } = logs(), { writer, writes } = fakeWriter({ logger });
  for (let i = 0; i < 100; i++) writer.record({ snapshot: snapshot({ observed_at: SEC + i }), resetRejected: false });
  await writer.flush();
  assert.ok(writes.length >= 1 && writes.length <= 2); assert.equal(JSON.parse(writes.at(-1)!).observed_at, SEC + 99);
  assert.deepEqual(events, []);
});
it("TP-36 flush waits for in-flight and latest writes without overlap", async () => {
  const releases: (() => void)[] = [], texts: string[] = [];
  const { writer } = fakeWriter({ write: (text) => { texts.push(text); return new Promise((resolve) => releases.push(() => resolve({ ok: true }))); } });
  writer.record({ snapshot: snapshot(), resetRejected: false });
  await new Promise<void>((resolve) => setImmediate(resolve));
  writer.record({ snapshot: snapshot({ observed_at: SEC + 1, plan_type: "pro" }), resetRejected: false });
  let flushed = false;
  const flush = writer.flush().then(() => { flushed = true; });
  assert.equal(texts.length, 1); assert.equal(flushed, false);
  releases[0]!(); await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(texts.length, 2); assert.equal(flushed, false);
  releases[1]!(); await flush;
  assert.equal(flushed, true); assert.equal(JSON.parse(texts[1]!).observed_at, SEC + 1);
});
it("TP-37 drops older snapshots and accepts a backward clock beyond five minutes", async () => {
  let now = SEC * 1000;
  const { writer, writes } = fakeWriter({ now: () => now });
  writer.record({ snapshot: snapshot(), resetRejected: false }); await writer.flush();
  writer.record({ snapshot: snapshot({ observed_at: SEC - 1, plan_type: "pro" }), resetRejected: false }); await writer.flush();
  assert.equal(writes.length, 1);
  now -= 301000;
  writer.record({ snapshot: snapshot({ observed_at: SEC - 301, plan_type: "pro" }), resetRejected: false }); await writer.flush();
  assert.equal(writes.length, 2);
});
it("TP-39 skips identical content for 30 seconds but writes every changed field", async () => {
  let now = SEC * 1000;
  const { writer, writes } = fakeWriter({ now: () => now });
  writer.record({ snapshot: snapshot(), resetRejected: false }); await writer.flush();
  now += 29999;
  writer.record({ snapshot: snapshot({ observed_at: SEC + 29 }), resetRejected: false }); await writer.flush(); assert.equal(writes.length, 1);
  now++;
  writer.record({ snapshot: snapshot({ observed_at: SEC + 30 }), resetRejected: false }); await writer.flush(); assert.equal(writes.length, 2);
  const changes: Partial<CodexQuotaSnapshot>[] = [{ windows: [{ window_minutes: 300, used_percent: 26, resets_at: SEC + 600 }] },
    { windows: [{ window_minutes: 301, used_percent: 25, resets_at: SEC + 600 }] },
    { windows: [{ window_minutes: 300, used_percent: 25, resets_at: SEC + 601 }] },
    { rate_limit_reached_type: "weekly" }, { plan_type: "pro" }, { active_limit: "extra" }, { limit_name: "Extra" },
    { credits: { has_credits: true, unlimited: false, balance: 1 } }, { additional_limits: [{ limit_id: "extra", limit_name: null, windows: snapshot().windows }] }, { source: "usage-endpoint", observed_at: SEC + 31 }];
  for (const change of changes) {
    const pair = fakeWriter();
    pair.writer.record({ snapshot: snapshot(), resetRejected: false }); await pair.writer.flush();
    pair.writer.record({ snapshot: snapshot({ ...change }), resetRejected: false }); await pair.writer.flush();
    assert.equal(pair.writes.length, 2, JSON.stringify(change));
  }
  now -= 1;
  writer.record({ snapshot: snapshot({ observed_at: SEC + 30 }), resetRejected: false }); await writer.flush();
  assert.equal(writes.length, 3);

});
it("TP-45 TP-47 reads named families in one pass and never builds a header name from a value", () => {
  const names: string[] = []; let passes = 0;
  const base = raw(Object.entries({ ...values(), ...family("extra-fast"),
    "x-codex-extra-fast-secondary-used-percent": "40", "x-codex-extra-fast-secondary-window-minutes": "1",
    "x-codex-extra-fast-secondary-reset-at": "1800000030", "x-codex-active-limit": "extra-fast" }), (name) => names.push(name));
  const p = parseCodexQuotaHeaders({ get: base.get, entries() { passes++; return base.entries(); } }, SEC);
  assert.deepEqual(names, fixedNames); assert.equal(passes, 1);
  assert.equal(p.snapshot?.active_limit, "extra-fast");
  assert.deepEqual(p.snapshot?.additional_limits, [{ limit_id: "extra-fast", limit_name: "Extra limit", windows: [
    { window_minutes: 1, used_percent: 40, resets_at: 1800000030 }, { window_minutes: 300, used_percent: 75, resets_at: 1800000300 }] }]);
  assert.deepEqual(p.snapshot?.windows, [{ window_minutes: 300, used_percent: 25, resets_at: 1800000600 }, { window_minutes: 10080, used_percent: 50, resets_at: 1800001200 }]);
});
it("TP-46 bounds family ids, count, name length and header iteration", () => {
  assert.deepEqual(parsed({ "x-codex-empty-limit-name": "No windows" }).snapshot?.additional_limits, []);
  const entries: [string, string][] = Object.entries(values());
  for (const id of ["bad!", "a-b-c-d-e", "x".repeat(49), "codex", "x".repeat(100)]) entries.push(...Object.entries(family(id)));
  for (let i = 0; i < 9; i++) entries.push(...Object.entries(family(`f${i}`)));
  assert.deepEqual(parseCodexQuotaHeaders(raw(entries), SEC).snapshot?.additional_limits.map((x) => x.limit_id), ["f0", "f1", "f2", "f3", "f4", "f5", "f6", "f7"]);
  let nexts = 0;
  const h: QuotaHeaders = { get: headers().get.bind(headers()), entries: () => ({ next() { nexts++; return { done: false, value: ["ignore", "x"] as [string, string] }; } }) };
  assert.equal(parseCodexQuotaHeaders(h, SEC).snapshot?.windows.length, 2); assert.equal(nexts, 512);
});
it("TP-48 parses exact credit booleans and balance or null", () => {
  assert.deepEqual(parsed({ "x-codex-credits-has-credits": "true", "x-codex-credits-unlimited": "false", "x-codex-credits-balance": "12.25" }).snapshot?.credits,
    { has_credits: true, unlimited: false, balance: 12.25 });
  for (const bad of ["TRUE", "true, false", "50, 60", "private", "1e3"]) {
    assert.deepEqual(parsed({ "x-codex-credits-has-credits": bad, "x-codex-credits-unlimited": bad, "x-codex-credits-balance": bad }).snapshot?.credits,
      { has_credits: null, unlimited: null, balance: null });
  }
  assert.equal(parsed().snapshot?.credits, null);
});
it("TP-49 keeps the largest allowed header input below four KiB", () => {
  const v = { ...values(), "x-codex-rate-limit-reached-type": "x".repeat(64), "x-codex-active-limit": "x".repeat(64),
    "x-codex-plan-type": "x".repeat(32), "x-codex-limit-name": "x".repeat(64),
    "x-codex-credits-has-credits": "true", "x-codex-credits-unlimited": "false", "x-codex-credits-balance": "999999999999999.999999" };
  for (let i = 0; i < 8; i++) Object.assign(v, family(`${i}${"x".repeat(47)}`, "527040"), {
    [`x-codex-${i}${"x".repeat(47)}-limit-name`]: "x".repeat(64),
    [`x-codex-${i}${"x".repeat(47)}-secondary-used-percent`]: "100",
    [`x-codex-${i}${"x".repeat(47)}-secondary-window-minutes`]: "527039",
    [`x-codex-${i}${"x".repeat(47)}-secondary-reset-at`]: "1800000300" });
  const p = parseCodexQuotaHeaders(new Headers(v), SEC);
  assert.equal(p.snapshot?.additional_limits.length, 8);
  const text = serializeCodexQuota(p.snapshot!);
  assert.notEqual(text, undefined);
  assert.ok(Buffer.byteLength(text!) <= 4096);
});
it("TP-50 contains a failed write and a throwing logger without rejection", async () => {
  const { writer } = fakeWriter({ logger: { log() { throw Error("private logger"); } }, write: async () => { throw Error("private write"); } });
  writer.record({ snapshot: snapshot(), resetRejected: false });
  await assert.doesNotReject(writer.flush());
});
it("TP-51 retries an identical snapshot after a failed write", async () => {
  let attempts = 0;
  const { writer } = fakeWriter({ write: async () => ++attempts === 1 ? { ok: false, code: "codex_quota_unavailable", errorCode: "EACCES" } : { ok: true } });
  writer.record({ snapshot: snapshot(), resetRejected: false }); await writer.flush();
  writer.record({ snapshot: snapshot(), resetRejected: false }); await writer.flush();
  assert.equal(attempts, 2);
});
it("keeps header precedence in the slot and on disk when poll results arrive late", async () => {
  const { writer, writes } = fakeWriter();
  writer.record({ snapshot: snapshot({ observed_at: SEC + 1 }), resetRejected: false });
  writer.record({ snapshot: snapshot({ observed_at: SEC + 1, source: "usage-endpoint", plan_type: "pro" }), resetRejected: false });
  await writer.flush();
  assert.equal(JSON.parse(writes.at(-1)!).source, "response-headers");
  writer.record({ snapshot: snapshot({ observed_at: SEC, source: "usage-endpoint" }), resetRejected: false }); await writer.flush();
  assert.equal(writes.length, 1);
  writer.record({ snapshot: snapshot({ observed_at: SEC + 2, source: "usage-endpoint", plan_type: "pro" }), resetRejected: false }); await writer.flush();
  assert.equal(writes.length, 2);
});
