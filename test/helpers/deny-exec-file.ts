/**
 * Preload for test child processes (`node --import tsx --import <this file>`).
 *
 * The preload intercepts seven node:child_process functions in this process: spawn,
 * spawnSync, execFile, execFileSync, exec, execSync and fork. It is not a process sandbox.
 * It does not cover the ChildProcess class form, process.execve or grandchildren.
 * The replacements do not preserve util.promisify.custom.
 *
 * The preload writes "preload" to SUBSWITCH_TEST_EXEC_LOG as a positive control. It logs
 * each refused call as "<function> <file or command>".
 *
 * If SUBSWITCH_TEST_EXEC_ALLOW holds a JSON array of strings, spawn, spawnSync, execFile
 * and execFileSync can start this Node binary (process.execPath) with those exact arguments.
 * The preload logs each such call as "allowed <function> <file>". It refuses all other
 * calls to the seven replacements.
 *
 * If SUBSWITCH_TEST_FS_WATCH names a folder, the preload also logs each call of the file
 * functions in fs-path-recorder.ts at or inside that folder as "<module>.<function> <path>".
 * It does not refuse these calls, and it does not see other file functions.
 */
import { appendFileSync } from "node:fs";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { recordFsPaths } from "./fs-path-recorder.js";

const log = process.env["SUBSWITCH_TEST_EXEC_LOG"];
if (log === undefined) throw new Error("SUBSWITCH_TEST_EXEC_LOG must name the exec log file");
const watch = process.env["SUBSWITCH_TEST_FS_WATCH"];
if (watch !== undefined) recordFsPaths(watch, (call, path) => appendFileSync(log, `${call} ${path}\n`));

const parseAllowArgs = (value: string): readonly string[] => {
  const parsed: unknown = JSON.parse(value);
  if (!Array.isArray(parsed) || !parsed.every((arg) => typeof arg === "string")) {
    throw new Error("SUBSWITCH_TEST_EXEC_ALLOW must be a JSON array of strings");
  }
  return parsed;
};
const allowValue = process.env["SUBSWITCH_TEST_EXEC_ALLOW"];
const allowArgs = allowValue === undefined ? undefined : parseAllowArgs(allowValue);

const DENIED = ["spawn", "spawnSync", "execFile", "execFileSync", "exec", "execSync", "fork"] as const;
type Denied = (typeof DENIED)[number];
/** The functions that take a program file and an argument array. Only these can be allowed. */
const ALLOWABLE: ReadonlySet<Denied> = new Set(["spawn", "spawnSync", "execFile", "execFileSync"]);

const isAllowed = (name: Denied, file: unknown, args: unknown): boolean =>
  allowArgs !== undefined && ALLOWABLE.has(name) && file === process.execPath && Array.isArray(args) &&
  args.length === allowArgs.length && args.every((arg, index) => arg === allowArgs[index]);

type Starter = (file: unknown, args?: unknown, ...rest: unknown[]) => unknown;
const childProcess: Record<Denied, Starter> = createRequire(import.meta.url)("node:child_process");
for (const name of DENIED) {
  const original = childProcess[name];
  childProcess[name] = (file, args, ...rest) => {
    if (isAllowed(name, file, args)) {
      appendFileSync(log, `allowed ${name} ${String(file)}\n`);
      return original(file, args, ...rest);
    }
    appendFileSync(log, `${name} ${String(file)}\n`);
    throw new Error(`${name} is disabled in this test process`);
  };
}
// Copy the replacements into the ESM named exports, which src modules import.
syncBuiltinESMExports();
appendFileSync(log, "preload\n");
