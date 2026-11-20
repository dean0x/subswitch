/**
 * Preload for test child processes (`node --import tsx --import <this file>`).
 *
 * It replaces each node:child_process function that can start a program (spawn, spawnSync,
 * execFile, execFileSync, exec, execSync and fork) before the program under test loads, so
 * the child can never start a program, for example the macOS Keychain tool. The log file
 * named by SUBSWITCH_TEST_EXEC_LOG gets "preload" when this file runs, which is the positive
 * control that the preload ran, and one "<function> <file or command>" line for each attempt.
 */
import { appendFileSync } from "node:fs";
import { createRequire, syncBuiltinESMExports } from "node:module";

const log = process.env["SUBSWITCH_TEST_EXEC_LOG"];
if (log === undefined) throw new Error("SUBSWITCH_TEST_EXEC_LOG must name the exec log file");

const DENIED = ["spawn", "spawnSync", "execFile", "execFileSync", "exec", "execSync", "fork"] as const;
type Denied = (typeof DENIED)[number];

const childProcess: Record<Denied, (file: unknown) => never> = createRequire(import.meta.url)("node:child_process");
for (const name of DENIED) {
  childProcess[name] = (file) => {
    appendFileSync(log, `${name} ${String(file)}\n`);
    throw new Error(`${name} is disabled in this test process`);
  };
}
// Copy the replacements into the ESM named exports, which src modules import.
syncBuiltinESMExports();
appendFileSync(log, "preload\n");
