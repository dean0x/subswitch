import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it, type TestContext } from "node:test";
import { DEFAULT_PORT } from "../../src/config.js";
import { createFileClaimStore, createTestPortAllocator, overlappingEphemeralRange } from "../helpers/test-port.js";

const FIRST = 20_000;
const LAST = 32_767;
const OWNER = 101;
const OTHER = 102;
const claimName = (pid: number) => `${pid}-00000000-0000-0000-0000-000000000000`;

function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), "subswitch-test-port-unit-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const claims = createFileClaimStore(root);
  const allocator = (overrides: Partial<Parameters<typeof createTestPortAllocator>[0]> = {}) =>
    createTestPortAllocator({
      pid: OWNER, isPidAlive: () => true, randomOffset: () => 0, canBind: async () => true, claims, ...overrides,
    });
  const claimNames = (port: number) => readdirSync(join(root, String(port)));
  const claimCount = (port: number) => claimNames(port).length;
  const portFolder = join(root, String(FIRST));
  const writeEntry = (name: string) => {
    mkdirSync(portFolder, { recursive: true, mode: 0o700 });
    writeFileSync(join(portFolder, name), "", { mode: 0o600 });
  };
  return { allocator, claimCount, claimNames, root, writeEntry };
}

async function reserved(allocator: ReturnType<typeof createTestPortAllocator>) {
  const result = await allocator.reserve();
  assert.ok(result.ok, result.ok ? undefined : result.error.message);
  return result.value;
}

it("reserves a port in the test range and outside the relay defaults", async (t) => {
  const { allocator } = fixture(t);
  const { port } = await reserved(allocator({ randomOffset: (size: number) => size - 1 }));
  assert.equal(port, LAST);
  assert.notEqual(port, 4141);
  assert.notEqual(port, DEFAULT_PORT);
});

it("skips a port when the bind check reports it busy", async (t) => {
  const { allocator, claimCount } = fixture(t);
  const { port } = await reserved(allocator({ canBind: async (candidate: number) => candidate !== FIRST }));
  assert.equal(port, FIRST + 1);
  assert.equal(claimCount(FIRST), 0);
});

it("reports only valid ephemeral ranges that overlap the test range", () => {
  assert.equal(overlappingEphemeralRange("32768\t60999\n"), undefined);
  assert.deepEqual(overlappingEphemeralRange("1024 65535"), [1024, 65_535]);
  assert.equal(overlappingEphemeralRange("bad text"), undefined);
});

it("refuses to reserve when the host ephemeral range overlaps the test range", async (t) => {
  const { allocator, root } = fixture(t);
  const overrides = { hostEphemeralRange: "1024 65535", randomOffset: () => 0 };
  const result = await allocator(overrides).reserve();
  assert.equal(result.ok, false);
  assert.match(result.error.message, /Host ephemeral port range 1024-65535 overlaps test port range 20000-32767/);
  assert.deepEqual(readdirSync(root), []);
});

it("reserves distinct ports for two allocators", async (t) => {
  const { allocator } = fixture(t);
  const [first, second] = await Promise.all([reserved(allocator()), reserved(allocator({ pid: OTHER }))]);
  assert.equal(first.port, FIRST);
  assert.equal(second.port, FIRST + 1);
});

it("skips a port with a pre-existing live claim and keeps that claim", async (t) => {
  const { allocator, claimNames, writeEntry } = fixture(t);
  const rival = claimName(OTHER);
  writeEntry(rival);
  const { port } = await reserved(allocator());
  assert.equal(port, FIRST + 1);
  assert.deepEqual(claimNames(FIRST), [rival]);
});

it("skips a port when a rival claim appears during the read of a stale claim", async (t) => {
  const { allocator, claimNames, writeEntry } = fixture(t);
  const rival = claimName(OTHER + 1);
  writeEntry(claimName(OTHER));
  const { port } = await reserved(allocator({ isPidAlive: (pid) => {
    if (pid !== OTHER) return true;
    writeEntry(rival);
    return false;
  } }));
  assert.equal(port, FIRST + 1);
  assert.deepEqual(claimNames(FIRST), [rival]);
});

it("skips a port with a non-claim file and keeps that file", async (t) => {
  const { allocator, claimNames, writeEntry } = fixture(t);
  writeEntry(".DS_Store");
  const { port } = await reserved(allocator());
  assert.equal(port, FIRST + 1);
  assert.deepEqual(claimNames(FIRST), [".DS_Store"]);
});

it("reuses a port from a dead owner", async (t) => {
  const { allocator, claimCount } = fixture(t);
  const dead = await reserved(allocator({ pid: OTHER }));
  const live = await reserved(allocator({ isPidAlive: (pid: number) => pid !== OTHER }));
  assert.equal(live.port, dead.port);
  assert.equal(claimCount(live.port), 1);
  dead.release();
  assert.equal(claimCount(live.port), 1);
});

it("reports exhaustion after 64 candidates and wraps within the range", async (t) => {
  const { allocator } = fixture(t);
  const checked: number[] = [];
  const result = await allocator({
    randomOffset: (size: number) => size - 1,
    canBind: async (port: number) => { checked.push(port); return false; },
  }).reserve();
  assert.equal(result.ok, false);
  assert.match(result.error.message, /No free test port.*64 candidates/);
  assert.deepEqual(checked, [LAST, ...Array.from({ length: 63 }, (_, index) => FIRST + index)]);
});

it("releases only the claims of this allocator", async (t) => {
  const { allocator, claimCount } = fixture(t);
  const firstOwner = allocator();
  const first = await reserved(firstOwner);
  const other = await reserved(allocator({ pid: OTHER }));
  const last = await reserved(firstOwner);
  first.release();
  assert.equal(claimCount(first.port), 0);
  assert.equal(claimCount(last.port), 1);
  firstOwner.releaseAll();
  assert.equal(claimCount(last.port), 0);
  assert.equal(claimCount(other.port), 1);
});

it("keeps a new claim when the same allocator calls an old release", async (t) => {
  const { allocator, claimNames } = fixture(t);
  const owner = allocator();
  const old = await reserved(owner);
  old.release();
  const current = await reserved(owner);
  assert.equal(current.port, old.port);
  const names = claimNames(current.port);
  old.release();
  assert.deepEqual(claimNames(current.port), names);
  current.release();
  assert.deepEqual(claimNames(current.port), []);
});

it("reserves distinct ports for the same process", async (t) => {
  const { allocator } = fixture(t);
  const owner = allocator();
  const [first, second] = await Promise.all([reserved(owner), reserved(owner)]);
  assert.equal(first.port, FIRST);
  assert.equal(second.port, FIRST + 1);
});

it("releases the claim when the bind check fails", async (t) => {
  const { allocator, claimCount } = fixture(t);
  const fault = new Error("Bind check failed");
  const result = await allocator({ canBind: async () => { throw fault; } }).reserve();
  assert.deepEqual(result, { ok: false, error: fault });
  assert.equal(claimCount(FIRST), 0);
});

it("refuses a linked claim folder", async (t) => {
  const { allocator, root } = fixture(t);
  const target = join(root, "target");
  const linked = join(root, "linked");
  mkdirSync(target, { mode: 0o700 });
  symlinkSync(target, linked);
  const result = await allocator({ claims: createFileClaimStore(linked) }).reserve();
  assert.equal(result.ok, false);
  assert.match(result.error.message, /Unsafe test port claim folder/);
  assert.deepEqual(readdirSync(target), []);
});
