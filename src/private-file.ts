import {
  closeSync, constants, fstatSync, lstatSync, openSync, writeSync, type Stats,
} from "node:fs";
import { lstat, mkdir, open, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import { err, ok, type Result } from "./result.js";
import { isPrivateFolder } from "./routing/state-dir.js";

export interface PrivateFilePath {
  readonly directory: string;
  readonly stem: string;
  readonly extension: string;
}

export interface PrivateFileRotation extends PrivateFilePath {
  readonly maxBytes: number;
  readonly fileCount: number;
}

// NONBLOCK prevents an open on a FIFO from waiting before fstat can refuse it.
const APPEND = constants.O_APPEND | constants.O_CREAT | constants.O_WRONLY |
  constants.O_NOFOLLOW | constants.O_NONBLOCK;
const FILE_MODE = 0o600;
const DIRECTORY_MODE = 0o700;
const MAX_FILES = 32;
const NAME_PART = /^[a-zA-Z0-9_-]+$/;

function pathAt(target: PrivateFilePath, index: number): string {
  if (!NAME_PART.test(target.stem) || !NAME_PART.test(target.extension)) {
    throw new Error("invalid_private_file_name");
  }
  const suffix = index === 0 ? "" : `.${index}`;
  return join(target.directory, `${target.stem}${suffix}.${target.extension}`);
}

function assertPrivateFolder(stat: Stats): void {
  if (!isPrivateFolder(stat) || (stat.mode & 0o7777) !== DIRECTORY_MODE) {
    throw new Error("unsafe_private_directory");
  }
}

function assertPrivateFile(stat: Stats): void {
  const uid = process.getuid?.();
  if (!stat.isFile() || stat.nlink !== 1 || (stat.mode & 0o077) !== 0 ||
      (uid !== undefined && uid !== stat.uid)) {
    throw new Error("unsafe_private_file");
  }
}

async function rotate(target: PrivateFileRotation, active: string): Promise<void> {
  // Check every slot before the first change to the file names.
  const slots: (string | undefined)[] = [active];
  for (let index = 1; index < target.fileCount; index++) {
    const path = pathAt(target, index);
    try {
      assertPrivateFile(await lstat(path));
      slots.push(path);
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
      slots.push(undefined);
    }
  }
  const oldest = slots[target.fileCount - 1];
  if (oldest !== undefined) await unlink(oldest);
  for (let index = target.fileCount - 2; index >= 0; index--) {
    const source = slots[index];
    if (source !== undefined) await rename(source, pathAt(target, index + 1));
  }
}

/** The caller serializes appends for each file. The cap applies before each append. */
export async function appendRotatingPrivateFile(target: PrivateFileRotation, data: string): Promise<void> {
  const bytes = Buffer.byteLength(data);
  if (!Number.isSafeInteger(target.maxBytes) || target.maxBytes < 1 || bytes > target.maxBytes ||
      !Number.isInteger(target.fileCount) || target.fileCount < 1 || target.fileCount > MAX_FILES) {
    throw new Error("invalid_private_file_rotation");
  }
  const path = pathAt(target, 0);
  await mkdir(target.directory, { recursive: true, mode: DIRECTORY_MODE });
  assertPrivateFolder(await lstat(target.directory));

  const file = await open(path, APPEND, FILE_MODE);
  try {
    const stat = await file.stat();
    assertPrivateFile(stat);
    if (stat.size + bytes <= target.maxBytes) {
      await file.writeFile(data);
      return;
    }
  } finally {
    await file.close();
  }

  await rotate(target, path);
  const fresh = await open(path, APPEND, FILE_MODE);
  try {
    const stat = await fresh.stat();
    assertPrivateFile(stat);
    if (stat.size + bytes > target.maxBytes) throw new Error("private_file_full");
    await fresh.writeFile(data);
  } finally {
    await fresh.close();
  }
}

/** Best-effort append for an exit handler. The next async write handles rotation. */
export function appendPrivateLineSync(target: PrivateFilePath, line: string): Result<void, "private_file_unavailable"> {
  try {
    assertPrivateFolder(lstatSync(target.directory));
    const file = openSync(pathAt(target, 0), APPEND, FILE_MODE);
    try {
      assertPrivateFile(fstatSync(file));
      const written = writeSync(file, line);
      return written === Buffer.byteLength(line) ? ok(undefined) : err("private_file_unavailable");
    } finally {
      closeSync(file);
    }
  } catch {
    return err("private_file_unavailable");
  }
}
