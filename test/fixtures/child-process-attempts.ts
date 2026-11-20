/**
 * Fixture program for the exec-deny preload test. It calls each node:child_process function
 * that can start a program once, with this Node binary and --version as a harmless target,
 * and prints one JSON object: each function name with "started" or "refused".
 *
 * With the argument "child" it exits at once: that is the program that fork starts.
 * With the argument "allow-list" it also starts this Node binary with other arguments, and
 * another program with the same arguments, for the allow-list mode of the preload.
 */
import { exec, execFile, execFileSync, execSync, fork, spawn, spawnSync, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";

if (process.argv[2] === "child") process.exit(0);

const target = process.execPath;
const results: Record<string, "started" | "refused"> = {};

const attempt = async (name: string, run: () => unknown): Promise<void> => {
  try {
    await run();
    results[name] = "started";
  } catch {
    results[name] = "refused";
  }
};

const exited = (child: ChildProcess): Promise<void> =>
  new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", () => resolve());
  });

const callback = (start: (done: (error: Error | null) => void) => unknown): Promise<void> =>
  new Promise((resolve, reject) => {
    start((error) => (error === null ? resolve() : reject(error)));
  });

await attempt("spawn", () => exited(spawn(target, ["--version"], { stdio: "ignore" })));
await attempt("spawnSync", () => {
  const result = spawnSync(target, ["--version"]);
  if (result.error !== undefined) throw result.error;
});
await attempt("execFile", () => callback((done) => execFile(target, ["--version"], done)));
await attempt("execFileSync", () => execFileSync(target, ["--version"]));
await attempt("exec", () => callback((done) => exec(`"${target}" --version`, done)));
await attempt("execSync", () => execSync(`"${target}" --version`));
await attempt("fork", () => exited(fork(fileURLToPath(import.meta.url), ["child"], { stdio: "ignore" })));
if (process.argv[2] === "allow-list") {
  await attempt("spawn other arguments", () => exited(spawn(target, ["--print", "0"], { stdio: "ignore" })));
  await attempt("spawn other program", () => exited(spawn("/bin/sh", ["--version"], { stdio: "ignore" })));
}

process.stdout.write(JSON.stringify(results));
