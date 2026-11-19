/**
 * Preload for CLI child processes (`node --import tsx --import <this file>`).
 *
 * It replaces child_process.execFile before the CLI loads, so the child can never
 * start a program through it (for example the macOS Keychain tool). The log file named
 * by SUBSWITCH_TEST_EXEC_LOG gets "preload" when this file runs and one "exec <file>"
 * line for each attempt.
 */
import { appendFileSync } from "node:fs";
import { createRequire, syncBuiltinESMExports } from "node:module";

const log = process.env["SUBSWITCH_TEST_EXEC_LOG"];
if (log === undefined) throw new Error("SUBSWITCH_TEST_EXEC_LOG must name the exec log file");

const childProcess: { execFile: (file: string) => never } = createRequire(import.meta.url)("node:child_process");
childProcess.execFile = (file) => {
  appendFileSync(log, `exec ${file}\n`);
  throw new Error("execFile is disabled in this test process");
};
// Copy the replacement into the ESM named exports, which src modules import.
syncBuiltinESMExports();
appendFileSync(log, "preload\n");
