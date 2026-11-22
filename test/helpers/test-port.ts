import assert from "node:assert/strict";
import { randomInt, randomUUID } from "node:crypto";
import { closeSync, lstatSync, mkdirSync, openSync, opendirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DEFAULT_PORT } from "../../src/config.js";
import { err, ok, type Result } from "../../src/result.js";
import { isPrivateFolder } from "../../src/routing/state-dir.js";

const LINUX_EPHEMERAL_RANGE = "/proc/sys/net/ipv4/ip_local_port_range";
// This range is below the default ephemeral ranges on Linux and macOS.
const FIRST_PORT = 20_000;
const LAST_PORT = 32_767;
const PORT_COUNT = LAST_PORT - FIRST_PORT + 1;
const MAX_ATTEMPTS = 64;
const MAX_CLAIMS_PER_PORT = 64;
const CLAIM_NAME = /^([1-9]\d{0,9})-[0-9a-f-]{36}$/;

interface Claims {
  readonly tryClaim: (port: number, pid: number, isAlive: (pid: number) => boolean) => (() => void) | undefined;
}

interface PortDeps {
  readonly claims: Claims;
  readonly pid: number;
  readonly isPidAlive: (pid: number) => boolean;
  readonly randomOffset: (size: number) => number;
  readonly canBind: (port: number) => Promise<boolean>;
  readonly hostEphemeralRange?: string | undefined;
}

interface TestPort {
  readonly port: number;
  readonly release: () => void;
}

export function overlappingEphemeralRange(text: string): readonly [number, number] | undefined {
  const match = /^(\d{1,5})\s+(\d{1,5})$/.exec(text.trim());
  if (match === null) return undefined;
  const first = Number(match[1]);
  const last = Number(match[2]);
  if (first < 1 || last > 65_535 || first > last) return undefined;
  return first <= LAST_PORT && last >= FIRST_PORT ? [first, last] : undefined;
}

function readHostEphemeralRange(): string | undefined {
  if (process.platform !== "linux") return undefined;
  try {
    return readFileSync(LINUX_EPHEMERAL_RANGE, "utf8");
  } catch {
    return undefined;
  }
}

function ensureClaimFolder(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  assert.ok(isPrivateFolder(lstatSync(path)), `Unsafe test port claim folder: ${path}`);
}

function validPid(pid: number): boolean {
  return Number.isInteger(pid) && pid > 0 && pid <= 0x7fff_ffff;
}

function hasOnlyClaim(folder: string, name: string): boolean {
  const entries = opendirSync(folder);
  try {
    return entries.readSync()?.name === name && entries.readSync() === null;
  } finally {
    entries.closeSync();
  }
}

function canKeepClaim(folder: string, name: string, isAlive: (pid: number) => boolean): boolean {
  const entries = opendirSync(folder);
  let pruned = false;
  try {
    for (let index = 0; index < MAX_CLAIMS_PER_PORT; index++) {
      const entry = entries.readSync();
      // The open directory may not show a rival claim that appeared during the PID check.
      if (entry === null) return !pruned || hasOnlyClaim(folder, name);
      if (entry.name === name) continue;
      // The name holds the PID even if the owner exits before the write completes.
      const owner = Number(CLAIM_NAME.exec(entry.name)?.[1]);
      if (!entry.isFile() || !validPid(owner) || isAlive(owner)) return false;
      rmSync(join(folder, entry.name), { force: true });
      pruned = true;
    }
    return false;
  } finally {
    entries.closeSync();
  }
}

// Port search packages do not share claims across processes. Use exclusive files instead.
export function createFileClaimStore(root: string): Claims {
  return {
    tryClaim: (port, pid, isAlive) => {
      ensureClaimFolder(root);
      const folder = join(root, String(port));
      ensureClaimFolder(folder);
      // Publish before the scan. If claims overlap, the later publisher can see the earlier one.
      // Use a unique name so two stale claim removals can not delete a new owner's claim.
      const name = `${pid}-${randomUUID()}`;
      const path = join(folder, name);
      const release = () => rmSync(path, { force: true });
      const file = openSync(path, "wx", 0o600);
      let keep = false;
      try {
        try { writeFileSync(file, String(pid)); } finally { closeSync(file); }
        keep = canKeepClaim(folder, name, isAlive);
        return keep ? release : undefined;
      } finally {
        if (!keep) release();
      }
    },
  };
}

export function createTestPortAllocator(deps: PortDeps) {
  const active = new Map<number, () => void>();
  const overlap = overlappingEphemeralRange(deps.hostEphemeralRange ?? "");
  const reserve = async (): Promise<Result<TestPort, Error>> => {
    if (overlap !== undefined) {
      const [first, last] = overlap;
      return err(new Error(`Host ephemeral port range ${first}-${last} overlaps test port range ${FIRST_PORT}-${LAST_PORT}`));
    }
    try {
      assert.ok(validPid(deps.pid), "Invalid test port owner PID");
      const offset = deps.randomOffset(PORT_COUNT);
      assert.ok(Number.isInteger(offset) && offset >= 0 && offset < PORT_COUNT, "Invalid test port offset");
      const isAlive = (pid: number) => pid === deps.pid || deps.isPidAlive(pid);
      for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
        const port = FIRST_PORT + (offset + attempt) % PORT_COUNT;
        assert.ok(port !== 4141 && port !== DEFAULT_PORT, "Reserved relay test port");
        if (active.has(port)) continue;
        const unlock = deps.claims.tryClaim(port, deps.pid, isAlive);
        if (unlock === undefined) continue;
        const release = () => {
          if (active.get(port) !== release) return;
          unlock();
          active.delete(port);
        };
        active.set(port, release);
        let bound = false;
        try {
          bound = await deps.canBind(port);
          if (bound) return ok({ port, release });
        } finally {
          if (!bound) release();
        }
      }
      return err(new Error(`No free test port in ${FIRST_PORT}-${LAST_PORT} after ${MAX_ATTEMPTS} candidates`));
    } catch (cause) {
      return err(cause instanceof Error ? cause : new Error("Test port reservation failed", { cause }));
    }
  };
  return { reserve, releaseAll: () => { for (const release of active.values()) release(); } };
}

function errorCode(error: unknown): unknown {
  return error instanceof Error && "code" in error ? error.code : undefined;
}

async function canBind(port: number): Promise<boolean> {
  const server = createServer((socket) => socket.destroy());
  try {
    await new Promise<void>((done, fail) => {
      server.once("error", fail);
      server.listen(port, "127.0.0.1", done);
    });
  } catch (error) {
    if (errorCode(error) === "EADDRINUSE") return false;
    throw error;
  }
  try {
    const address = server.address();
    assert.ok(address && typeof address !== "string", "Missing test port address");
    assert.ok(address.port !== 4141 && address.port !== DEFAULT_PORT, "Reserved relay test port");
    assert.equal(address.port, port, "Unexpected test port");
    return true;
  } finally {
    await new Promise<void>((done, fail) => server.close((error) => error ? fail(error) : done()));
  }
}

// Test workers inherit TMPDIR from the runner. Their CLI children can have distinct HOME values.
const sharedRoot = resolve(tmpdir(), `subswitch-test-ports-${process.getuid?.() ?? "user"}`);
const probePid = process.kill.bind(process);
const testPorts = createTestPortAllocator({
  hostEphemeralRange: readHostEphemeralRange(),
  claims: createFileClaimStore(sharedRoot),
  pid: process.pid,
  isPidAlive: (pid) => {
    try {
      probePid(pid, 0);
      return true;
    } catch (error) {
      return errorCode(error) !== "ESRCH";
    }
  },
  randomOffset: randomInt,
  canBind,
});
process.once("exit", testPorts.releaseAll);

export async function reserveTestPort(): Promise<TestPort> {
  const result = await testPorts.reserve();
  if (!result.ok) throw result.error;
  return result.value;
}
