import assert from "node:assert/strict";
import { it } from "node:test";
import {
  createKeychainReader, keychainReadErrors, type KeychainReadError, type KeychainReaderDeps,
} from "../../src/keychain-read.js";
import type { Result } from "../../src/result.js";

const item = { service: "Claude Code", account: "fake-claude-account" };
const path = "/fake-home/Library/Keychains/login.keychain-db";
const fakeValue = "FAKE-CLAUDE-KEYCHAIN-VALUE";
const metadata = (date: string, hex = Buffer.from(`${date}\0`, "ascii").toString("hex")) =>
  `keychain: "${path}"\nattributes:\n    "mdat"<timedate>=0x${hex}  "${date}\\000"\n`;
const date = "20240229123456Z";

const harness = (overrides: Partial<KeychainReaderDeps> = {}) => {
  const calls: Parameters<KeychainReaderDeps["exec"]>[] = [];
  const timers: { expire: () => void; ms: number; canceled: boolean }[] = [];
  const exec = overrides.exec ?? (async () => ({ stdout: `${fakeValue}\n` }));
  const reader = createKeychainReader({
    platform: "darwin", env: {}, loginKeychainPath: path, ...overrides,
    exec: (...args) => { calls.push(args); return exec(...args); },
    setTimer: (expire, ms) => {
      const timer = { expire, ms, canceled: false };
      timers.push(timer);
      return () => { timer.canceled = true; };
    },
  });
  return { ...reader, calls, timers };
};

const assertError = (result: Result<unknown, KeychainReadError>, code: KeychainReadError) => {
  assert.equal(!result.ok && result.error === code, true, `expected fixed code: ${code}`);
};

it("reads with only the fixed execFile, argv and bounds", async () => {
  const { readSecret, calls, timers } = harness({ env: { HOME: "/fake-home", PATH: "/fake-bin" } });
  const result = await readSecret(item);
  assert.equal(result.ok && result.value === fakeValue, true);
  assert.equal(calls.length, 1);
  const call = calls[0];
  assert.ok(call);
  const [file, args, options] = call;
  assert.deepEqual([file, args], [
    "/usr/bin/security", ["find-generic-password", "-s", "Claude Code", "-a", "fake-claude-account", "-w", path],
  ]);
  assert.deepEqual(options, {
    env: { HOME: "/fake-home" }, encoding: "utf8", shell: false, timeout: 10_000,
    maxBuffer: 65_536, killSignal: "SIGKILL", signal: options.signal,
  });
  assert.ok(options.signal instanceof AbortSignal);
  assert.deepEqual(timers.map(({ ms, canceled }) => ({ ms, canceled })), [{ ms: 10_000, canceled: true }]);
});

it("probes with attributes only and returns the UTC modification time", async () => {
  let stderrReads = 0;
  const exec = async () => ({
    stdout: metadata(date, "32303234303232393132333435365A00"),
    get stderr() { stderrReads++; return fakeValue; },
  });
  const { probe, calls } = harness({ exec });
  assert.deepEqual(await probe(item), { ok: true, value: { modifiedAtMs: Date.UTC(2024, 1, 29, 12, 34, 56) } });
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0]?.slice(0, 2), [
    "/usr/bin/security", ["find-generic-password", "-s", "Claude Code", "-a", "fake-claude-account", path],
  ]);
  assert.deepEqual(calls[0]?.[2].env, {});
  assert.equal(stderrReads, 0);
});

it("rejects an option in place of the Keychain path without exec", async () => {
  const { readSecret, probe, calls } = harness({ loginKeychainPath: "-g" });
  assertError(await readSecret(item), "malformed");
  assertError(await probe(item), "malformed");
  assert.equal(calls.length, 0);
});

it("returns before exec or a timer on an unsupported platform", async () => {
  const { readSecret, probe, calls, timers } = harness({ platform: "linux" });
  assertError(await readSecret(item), "unsupported_platform");
  assertError(await probe(item), "unsupported_platform");
  assert.equal(calls.length, 0);
  assert.equal(timers.length, 0);
});

it("preserves spaces in a value without a final newline", async () => {
  const { readSecret } = harness({ exec: async () => ({ stdout: ` ${fakeValue} ` }) });
  const result = await readSecret(item);
  assert.equal(result.ok && result.value === ` ${fakeValue} `, true);
});

for (const [name, stdout] of [
  ["empty", "\n"], ["whitespace only", " \n"], ["embedded newline", `${fakeValue}\n\n`],
  ["embedded NUL", `${fakeValue}\0\n`],
] as const) {
  it(`rejects a secret response: ${name}`, async () => {
    const { readSecret } = harness({ exec: async () => ({ stdout }) });
    assertError(await readSecret(item), "malformed");
  });
}

for (const [name, stdout] of [
  ["absent", "attributes:\n"], ["unknown format", metadata(date).replace("<timedate>", "<blob>")],
  ["duplicate", metadata(date).repeat(2)], ["mixed format", `${metadata(date)}    "mdat"=<NULL>\n`],
  ["a date that rolls over", metadata("20230229123456Z")],
  ["a date with a non-UTC suffix", metadata("20240229123456X")],
  ["conflicting hex and text", metadata(date, "30303030303030303030303030305A00")],
] as const) {
  it(`refuses modification data with ${name}`, async () => {
    const { probe } = harness({ exec: async () => ({ stdout }) });
    assertError(await probe(item), "malformed");
  });
}

it("returns a value at the byte limit and rejects output over it in either mode", async () => {
  const limit = 65_536;
  const stdout = `${"é".repeat((limit - 2) / 2)}x`;
  const atLimit = harness({ exec: async () => ({ stdout: `${stdout}\n` }) });
  const result = await atLimit.readSecret(item);
  assert.equal(result.ok && result.value === stdout, true);
  const overLimit = harness({ exec: async () => ({ stdout: `${stdout}x\n` }) });
  assertError(await overLimit.readSecret(item), "output_too_large");
  assertError(await overLimit.probe(item), "output_too_large");
});

for (const [name, fields, code] of [
  ["item not found (44, reported, not live)", { code: 44 }, "missing"],
  ["user canceled (128, reported, not live)", { code: 128 }, "denied"],
  ["interaction not allowed (36, reported, not live)", { code: 36 }, "denied"],
  ["authorization failed (51, reported, not live)", { code: 51 }, "denied"],
  ["exec timeout", { code: "ETIMEDOUT" }, "timeout"],
  ["exec buffer overflow", { code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" }, "output_too_large"],
  ["unknown status", { code: 1 }, "exec_failed"],
  ["unexpected execution error", { code: "ENOENT" }, "exec_failed"],
  ["signal end", { code: null, killed: true, signal: "SIGKILL" }, "exec_failed"],
  ["reported status with a signal", { code: 44, signal: "SIGTERM" }, "exec_failed"],
] as const) {
  it(`returns a fixed code for ${name} without access to stderr`, async () => {
    let stderrReads = 0;
    const failure = Object.assign(new Error(fakeValue), fields, { stdout: fakeValue });
    Object.defineProperty(failure, "stderr", { get: () => { stderrReads++; return fakeValue; } });
    const { readSecret, probe, timers } = harness({ exec: async () => { throw failure; } });
    assertError(await readSecret(item), code);
    assertError(await probe(item), code);
    assert.equal(stderrReads, 0);
    assert.deepEqual(timers.map(({ canceled }) => canceled), [true, true]);
  });
}

it("does not log process output or its error message", async (t) => {
  const exec = async () => { throw Object.assign(new Error(fakeValue), { stdout: fakeValue, stderr: fakeValue }); };
  const { readSecret, probe } = harness({ exec });
  const stdout = t.mock.method(process.stdout, "write", () => true);
  const stderr = t.mock.method(process.stderr, "write", () => true);
  assertError(await readSecret(item), "exec_failed");
  assertError(await probe(item), "exec_failed");
  assert.equal(stdout.mock.callCount() + stderr.mock.callCount(), 0);
});

it("maps a synchronous exec failure to the fixed fail-closed code", async () => {
  const { readSecret } = harness({ exec: () => { throw null; } });
  assertError(await readSecret(item), "exec_failed");
});

it("ends the wait and aborts exec at the deadline even if exec does not settle", async () => {
  const { readSecret, calls, timers } = harness({ exec: () => new Promise(() => {}) });
  const pending = readSecret(item);
  const timer = timers[0];
  assert.ok(timer);
  timer.expire();
  const fallback = { ok: false, error: "exec_failed" } as const;
  const result = await Promise.race([pending, new Promise<typeof fallback>((done) => setImmediate(() => done(fallback)))]);
  assertError(result, "timeout");
  assert.equal(calls[0]?.[2].signal.aborted, true);
  assert.equal(timer.canceled, true);
});

it("marks only denial, timeout and unclassified exec failure for a latch until restart", () => {
  assert.deepEqual(keychainReadErrors, {
    missing: { latchUntilRestart: false },
    denied: { latchUntilRestart: true },
    timeout: { latchUntilRestart: true },
    output_too_large: { latchUntilRestart: false },
    malformed: { latchUntilRestart: false },
    unsupported_platform: { latchUntilRestart: false },
    exec_failed: { latchUntilRestart: true },
  });
});
