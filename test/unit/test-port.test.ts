import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it, type TestContext } from "node:test";
import { DEFAULT_PORT } from "../../src/config.js";
import { createFileClaimStore, createTestPortAllocator } from "../helpers/test-port.js";

const FIRST = 20_000;
const LAST = 32_767;
const OWNER = 101;
const OTHER = 102;

function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), "subswitch-test-port-unit-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const claims = createFileClaimStore(root);
  const allocator = (overrides: Partial<Parameters<typeof createTestPortAllocator>[0]> = {}) =>
    createTestPortAllocator({
      pid: OWNER, isPidAlive: () => true, randomOffset: () => 0, canBind: async () => true, claims, ...overrides,
    });
  const claimCount = (port: number) => readdirSync(join(root, String(port))).length;
  return { allocator, claimCount, root };
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

it("skips a live claim from another owner during an overlapping reservation", async (t) => {
  const { allocator } = fixture(t);
  const [first, second] = await Promise.all([reserved(allocator()), reserved(allocator({ pid: OTHER }))]);
  assert.equal(first.port, FIRST);
  assert.equal(second.port, FIRST + 1);
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
