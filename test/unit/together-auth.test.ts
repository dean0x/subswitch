import assert from "node:assert/strict";
import { it } from "node:test";
import {
  createTogetherKeyReader, envKeyPresent, type TogetherKeyReaderDeps,
} from "../../src/together-auth.js";
import keys from "../fixtures/together/keys.json" with { type: "json" };

const keyEnv = (key: string) => ({ TOGETHER_API_KEY: key });
const signal = () => new AbortController().signal;
const keyFrom = (key: string, source: "env" | "keychain") => ({ ok: true, value: { key, source } });
const missing = { ok: false, error: "missing" };
const malformed = { ok: false, error: "malformed" };
const cancelled = { ok: false, error: "aborted" };

const deferredKey = () => {
  let resolve: ((output: { stdout: string }) => void) | undefined;
  const promise = new Promise<{ stdout: string }>((done) => { resolve = done; });
  assert.ok(resolve);
  return { promise, resolve };
};

const harness = (overrides: Partial<TogetherKeyReaderDeps> = {}) => {
  const calls: Parameters<TogetherKeyReaderDeps["exec"]>[] = [];
  const timers: { expire: () => void; delay: number; cleared: boolean }[] = [];
  const exec = overrides.exec ?? (async () => ({ stdout: keys.primary }));
  const deps: TogetherKeyReaderDeps = {
    env: {}, platform: "darwin", ...overrides,
    exec: (...args) => { calls.push(args); return exec(...args); },
    setTimer: (expire, delay) => {
      const timer = { expire, delay, cleared: false };
      timers.push(timer);
      return () => { timer.cleared = true; };
    },
  };
  return { ...createTogetherKeyReader(deps), calls, timers };
};

it("uses the env key before Keychain and holds it after the env changes", async () => {
  const env = keyEnv(keys.primary);
  const { readKey, calls, timers } = harness({ env });
  assert.deepEqual(await readKey(signal()), keyFrom(keys.primary, "env"));
  env.TOGETHER_API_KEY = keys.secondary;
  assert.deepEqual(await readKey(signal()), keyFrom(keys.primary, "env"));
  assert.equal(calls.length, 0);
  assert.equal(timers.length, 0);
});

it("runs the fixed Keychain command with bounded options and a HOME-only env", async () => {
  const env = { HOME: "/fake-home", PATH: "/fake-bin", UNRELATED: "discard" };
  const { readKey, calls, timers } = harness({ env });
  const request = signal();
  assert.deepEqual(await readKey(request), keyFrom(keys.primary, "keychain"));
  assert.equal(calls.length, 1);
  const [file, args, options] = calls[0]!;
  assert.equal(file, "/usr/bin/security");
  assert.deepEqual(args, ["find-generic-password", "-s", "Subswitch Together API key", "-a", "subswitch", "-w"]);
  assert.deepEqual(options, {
    env: { HOME: "/fake-home" }, timeout: 10_000, maxBuffer: 8192, encoding: "utf8",
    killSignal: "SIGKILL", signal: options.signal,
  });
  assert.ok(options.signal instanceof AbortSignal);
  assert.notEqual(options.signal, request);
  assert.equal(options.signal.aborted, false);
  assert.deepEqual(timers.map(({ delay, cleared }) => ({ delay, cleared })), [{ delay: 10_000, cleared: true }]);
});

it("does not call Keychain or start a timer on Linux", async () => {
  const { readKey, keychainItemExists, calls, timers } = harness({ platform: "linux" });
  assert.deepEqual(await readKey(signal()), missing);
  assert.equal(await keychainItemExists(), false);
  assert.equal(calls.length, 0);
  assert.equal(timers.length, 0);
});

it("reports an env key only when its value has a valid format", () => {
  assert.equal(envKeyPresent({}), false);
  assert.equal(envKeyPresent(keyEnv("")), false);
  assert.equal(envKeyPresent(keyEnv(`${keys.primary} `)), false);
  assert.equal(envKeyPresent(keyEnv(`${keys.primary}\n`)), true);
});

it("checks for the Keychain item without reading or holding its value", async () => {
  const { keychainItemExists, readKey, calls } = harness();
  assert.equal(await keychainItemExists(), true);
  assert.deepEqual(calls[0]?.[1], ["find-generic-password", "-s", "Subswitch Together API key", "-a", "subswitch"]);
  assert.deepEqual(await readKey(signal()), keyFrom(keys.primary, "keychain"));
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1]?.[2].env, {});
});

for (const [name, code] of [
  ["non-zero exit", 1], ["exec timeout", "ETIMEDOUT"],
  ["buffer overflow", "ERR_CHILD_PROCESS_STDIO_MAXBUFFER"], ["denial", 36],
] as const) {
  it(`returns no key or log for ${name}, even if the error has stdout`, async (t) => {
    const error = Object.assign(new Error(keys.secondary), { code, stdout: keys.primary });
    const { readKey, keychainItemExists, timers } = harness({ exec: async () => { throw error; } });
    const stdout = t.mock.method(process.stdout, "write", () => true);
    const stderr = t.mock.method(process.stderr, "write", () => true);
    const result = await readKey(signal());
    const exists = await keychainItemExists();
    stdout.mock.restore();
    stderr.mock.restore();
    assert.deepEqual(result, missing);
    assert.equal(exists, false);
    assert.equal(stdout.mock.callCount() + stderr.mock.callCount(), 0);
    assert.ok(timers.every((timer) => timer.cleared));
  });
}

it("removes one trailing newline and accepts 16 and 512 printable ASCII characters", async () => {
  for (const key of [keys.primary.slice(0, 16), keys.primary.padEnd(512, "X")]) {
    const { readKey } = harness({ exec: async () => ({ stdout: `${key}\n` }) });
    assert.deepEqual(await readKey(signal()), keyFrom(key, "keychain"));
  }
});

for (const [name, value] of [
  ["an empty value", ""], ["fewer than 16 characters", keys.primary.slice(0, 15)],
  ["more than 512 characters", keys.primary.padEnd(513, "X")],
  ["a leading space", ` ${keys.primary}`], ["a tab", `${keys.primary}\t`],
  ["two newlines", `${keys.primary}\n\n`], ["a carriage return", `${keys.primary}\r\n`],
  ["a null byte", `${keys.primary}\0`], ["a DEL character", `${keys.primary}\x7F`],
  ["a non-ASCII character", `${keys.primary}é`],
] as const) {
  it(`rejects ${name} in either source without echo or fallback`, async () => {
    const env = harness({ env: keyEnv(value) });
    assert.deepEqual(await env.readKey(signal()), malformed);
    assert.equal(env.calls.length, 0);
    const keychain = harness({ exec: async () => ({ stdout: value }) });
    assert.deepEqual(await keychain.readKey(signal()), malformed);
  });
}

it("refuses and does not hold a loaded key that the error scrub can not hold", async () => {
  const loaded: string[] = [];
  const onKeyLoaded = (key: string) => { loaded.push(key); return false; };
  const env = harness({ env: keyEnv(keys.primary), onKeyLoaded });
  assert.deepEqual(await env.readKey(signal()), malformed);
  assert.deepEqual(await env.readKey(signal()), malformed);
  const keychain = harness({ onKeyLoaded });
  assert.deepEqual(await keychain.readKey(signal()), malformed);
  assert.deepEqual(loaded, [keys.primary, keys.primary, keys.primary]);
});

it("shares one first read among ten waiters and holds the success", async () => {
  const child = deferredKey();
  const { readKey, calls, timers } = harness({ exec: () => child.promise });
  const waiters = Array.from({ length: 10 }, () => readKey(signal()));
  assert.equal(calls.length, 1);
  assert.equal(timers.length, 1);
  child.resolve({ stdout: keys.primary });
  assert.deepEqual(await Promise.all(waiters), Array(10).fill(keyFrom(keys.primary, "keychain")));
  assert.deepEqual(await readKey(signal()), keyFrom(keys.primary, "keychain"));
  assert.equal(calls.length, 1);
});

it("starts a new read after a failed Keychain attempt", async () => {
  let first = true;
  const { readKey, calls } = harness({ exec: async () => {
    if (first) { first = false; throw new Error("failure"); }
    return { stdout: keys.primary };
  } });
  assert.deepEqual(await readKey(signal()), missing);
  assert.deepEqual(await readKey(signal()), keyFrom(keys.primary, "keychain"));
  assert.equal(calls.length, 2);
});

it("ends the first client's wait without stopping the child for a second client", async () => {
  const child = deferredKey();
  const { readKey, calls } = harness({ exec: () => child.promise });
  const first = new AbortController();
  const a = readKey(first.signal);
  const b = readKey(signal());
  first.abort(new Error(keys.secondary));
  assert.deepEqual(await a, cancelled);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.[2].signal.aborted, false);
  child.resolve({ stdout: keys.primary });
  assert.deepEqual(await b, keyFrom(keys.primary, "keychain"));
});

it("stops the child when the last waiter cancels and preserves a new shared read", async () => {
  const child = deferredKey();
  const replacement = deferredKey();
  const { readKey, calls, timers } = harness({ exec: () => calls.length === 1
    ? child.promise : replacement.promise });
  const first = new AbortController();
  const second = new AbortController();
  const a = readKey(first.signal);
  const b = readKey(second.signal);
  first.abort();
  assert.deepEqual(await a, cancelled);
  second.abort();
  assert.deepEqual(await b, cancelled);
  assert.equal(calls[0]?.[2].signal.aborted, true);
  assert.equal(timers[0]?.cleared, true);

  const freshFirst = new AbortController();
  const freshSecond = new AbortController();
  const fresh = readKey(freshFirst.signal);
  child.resolve({ stdout: keys.primary });
  // Let the abandoned read finish before the second waiter joins the replacement.
  await new Promise<void>((done) => setImmediate(done));
  const joined = readKey(freshSecond.signal);
  assert.equal(calls.length, 2);
  freshFirst.abort();
  freshSecond.abort();
  assert.deepEqual(await Promise.all([fresh, joined]), [cancelled, cancelled]);
  assert.equal(calls[1]?.[2].signal.aborted, true);
});

it("bounds the whole shared wait even when the exec seam does not settle on abort", async () => {
  const { readKey, calls, timers } = harness({ exec: async () => new Promise(() => {}) });
  const request = signal();
  const result = readKey(request);
  const second = readKey(signal());
  timers[0]?.expire();
  assert.deepEqual(await Promise.all([result, second]), [missing, missing]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.[2].signal.aborted, true);
  assert.equal(request.aborted, false);
  assert.equal(timers[0]?.cleared, true);
});

it("does not start a read for an already-aborted caller", async () => {
  const { readKey, calls, timers } = harness();
  const request = AbortSignal.abort(new Error(keys.primary));
  assert.deepEqual(await readKey(request), cancelled);
  assert.equal(calls.length, 0);
  assert.equal(timers.length, 0);
});

// Typecheck this function, but do not execute an invalid dependency setup.
const checkRequiredSeams = ({ env, platform, exec, setTimer }: TogetherKeyReaderDeps) => {
  // @ts-expect-error The env seam is required.
  createTogetherKeyReader({ platform, exec, setTimer });
  // @ts-expect-error The platform seam is required.
  createTogetherKeyReader({ env, exec, setTimer });
  // @ts-expect-error The exec seam is required.
  createTogetherKeyReader({ env, platform, setTimer });
  // @ts-expect-error The timer seam is required.
  createTogetherKeyReader({ env, platform, exec });
};
void checkRequiredSeams;
