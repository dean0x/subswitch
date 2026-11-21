import { copyFile, lstat, mkdtemp, realpath, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { isAbsolute, join, normalize } from "node:path";
import { createInterface } from "node:readline";
import { err, ok, type Result } from "../../src/result.js";

export type Mode = "dry-run" | "live";
export interface LiveArguments { readonly mode: Mode; readonly evidenceRoot: string }
export type GateCode = "ci" | "no_tty" | "phrase_mismatch";
export interface GateIO {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly stdinIsTTY: boolean;
  readonly stdoutIsTTY: boolean;
  ask(prompt: string): Promise<string | undefined>;
}

const PRIVATE_SEGMENTS: ReadonlySet<string> = new Set([".claude", ".codex", ".kimi-code", ".kimi", ".ssh", ".gnupg"]);
const MODE_FLAGS: ReadonlyMap<string, Mode> = new Map([["--dry-run", "dry-run"], ["--live", "live"]]);

export function parseArguments(args: readonly string[]): LiveArguments | undefined {
  if (args.length !== 3) return undefined;
  const at = args.indexOf("--evidence-root");
  if (at < 0) return undefined;
  const evidenceRoot = args[at + 1];
  const flags = args.filter((_, index) => index !== at && index !== at + 1);
  const mode = flags.length === 1 ? MODE_FLAGS.get(flags[0] ?? "") : undefined;
  if (mode === undefined || evidenceRoot === undefined || !isAbsolute(evidenceRoot) || normalize(evidenceRoot) !== evidenceRoot ||
    /[\x00-\x1f\x7f]/.test(evidenceRoot) || evidenceRoot.split("/").some((part) => PRIVATE_SEGMENTS.has(part))) return undefined;
  return { mode, evidenceRoot };
}

export async function confirmLive(phrase: string, io: GateIO): Promise<Result<void, GateCode>> {
  if ("CI" in io.env || "GITHUB_ACTIONS" in io.env) return err("ci");
  if (!io.stdinIsTTY || !io.stdoutIsTTY) return err("no_tty");
  const answer = await io.ask(`Type this line to start the live check with its caps:\n  ${phrase}\n> `);
  return answer?.trim() === phrase ? ok(undefined) : err("phrase_mismatch");
}

export const askLine = (prompt: string): Promise<string | undefined> => new Promise((resolve) => {
  const terminal = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  const timer = setTimeout(() => terminal.close(), 120_000);
  terminal.once("close", () => { clearTimeout(timer); resolve(undefined); });
  terminal.question(prompt, (answer) => {
    resolve(answer.slice(0, 512));
    terminal.close();
  });
});

export const privateFolder = async (path: string): Promise<boolean> => {
  try {
    if (await realpath(path) !== path) return false;
    const stat = await lstat(path);
    return stat.isDirectory() && (stat.mode & 0o022) === 0 && (typeof process.getuid !== "function" || stat.uid === process.getuid());
  } catch {
    return false;
  }
};

export const prepareClientFolder = async (scratch: string, repoRoot: string): Promise<Result<string, "client_folder_failed">> => {
  try {
    const folder = await mkdtemp(join(scratch, "client-"));
    await copyFile(join(repoRoot, "package.json"), join(folder, "package.json"));
    return ok(folder);
  } catch {
    return err("client_folder_failed");
  }
};

export const freePort = (): Promise<number> => new Promise((resolve, reject) => {
  const probe = createServer();
  probe.once("error", reject);
  probe.listen(0, "127.0.0.1", () => {
    const address = probe.address();
    probe.close(() => (typeof address === "object" && address !== null ? resolve(address.port) : reject(new Error("no_port"))));
  });
});

/** Neither the harness nor run-action loads a user or project config in a dry run. */
export async function dryConfigEnv(scratch: string, home: string, temp: string, port: number): Promise<Record<string, string>> {
  const config = join(scratch, "dry-config.json");
  await writeFile(config, JSON.stringify({ port }), { mode: 0o600, flag: "wx" });
  return { PATH: process.env["PATH"] ?? "/usr/bin:/bin", HOME: home, XDG_CONFIG_HOME: join(home, ".config"),
    XDG_CACHE_HOME: join(home, ".cache"), TMPDIR: temp, LANG: "C", SUBSWITCH_CONFIG: config };
}

export const actionsDirectory = (home: string): string => join(home, ".cache", "subswitch", "actions");
