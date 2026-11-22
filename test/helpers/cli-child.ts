/**
 * The one way a test starts a src/cli.ts child process. A source-text guard checks that no
 * other test file names the CLI entry file.
 *
 * The child gets a fresh HOME, distinct XDG folders and a default SUBSWITCH_CONFIG file
 * with "{}". PATH and TMPDIR are the only defaults from the parent env. A test can add
 * env variables within the limits below. These defaults direct config and state lookups
 * to test folders. They do not restrict file access.
 *
 * The preload intercepts the seven named functions in deny-exec-file.ts in this child.
 * It is not a process sandbox. It does not cover the ChildProcess class form,
 * process.execve or grandchildren. The replacements do not preserve util.promisify.custom.
 * A run-action test can use allowNodeArgs to let an intercepted file-based call start
 * one exact Node command. A test can use recordFsUnder to log the named file calls of the
 * child in one folder of its home.
 */
import { execFile } from "node:child_process";
import { mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { isPlainObject } from "../../src/plain-object.js";
import { reserveTestPort } from "./test-port.js";

const CLI_ENTRY = fileURLToPath(new URL("../../src/cli.ts", import.meta.url));
const TSX = import.meta.resolve("tsx");
const DENY_PRELOAD = new URL("./deny-exec-file.ts", import.meta.url).href;

/** The variables that only the helper sets. */
const HELPER_VARIABLES = [
  "HOME", "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "SUBSWITCH_TEST_EXEC_LOG", "SUBSWITCH_TEST_EXEC_ALLOW", "SUBSWITCH_TEST_FS_WATCH",
] as const;
const FIXTURE_FOLDER_VARIABLES = [
  "CODEX_HOME", "CLAUDE_CONFIG_DIR", "SUBSWITCH_LIMIT_DIR", "XDG_STATE_HOME", "XDG_DATA_HOME",
] as const;

export interface CliChildFolders {
  /** HOME: a fresh folder from mkdtemp. The test removes it. */
  readonly home: string;
  /** XDG_CONFIG_HOME: `<home>/xdg-config`. */
  readonly configHome: string;
  /** XDG_CACHE_HOME: `<home>/xdg-cache`. */
  readonly cacheHome: string;
  /** The default SUBSWITCH_CONFIG: a file in the home folder that holds "{}". */
  readonly configFile: string;
  /** The exec-deny preload log. */
  readonly execLog: string;
}

export interface CliChildOptions {
  /** The working folder. The default is the home folder. */
  readonly cwd?: string;
  /**
   * More child variables. They can not set a variable in HELPER_VARIABLES. SUBSWITCH_CONFIG
   * can be "" (no explicit file) or a path below the home folder. FIXTURE_FOLDER_VARIABLES
   * must name paths in the child home or temporary root. Path checks do not follow symlinks.
   */
  readonly env?: Readonly<Record<string, string | undefined>>;
  /**
   * Allow-list mode of the exec-deny preload, for a run-action test that must start its client
   * command: the exact arguments of the one process.execPath command that the child may start.
   */
  readonly allowNodeArgs?: readonly string[];
  /**
   * A folder below the home folder. The preload logs each call of the named file functions
   * at or inside it to the exec log, as "<module>.<function> <path>". The exec log must not be
   * in it.
   */
  readonly recordFsUnder?: string;
}

export interface CliChildCommand {
  readonly file: string;
  readonly args: string[];
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
}

export interface CliChildResult {
  /** The exit code from a normal exit. */
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** Make a fresh CLI home. Use a real path outside shared temporary folders on Linux. */
export const cliChildFolders = async ({ resolveTemp = true }: { readonly resolveTemp?: boolean } = {}): Promise<CliChildFolders> => {
  const base = process.platform === "darwin" ? tmpdir() : homedir();
  const home = await mkdtemp(join(resolveTemp ? await realpath(base) : tmpdir(), "subswitch-cli-child-"));
  const folders: CliChildFolders = {
    home, configHome: join(home, "xdg-config"), cacheHome: join(home, "xdg-cache"),
    configFile: join(home, "subswitch-test-config.json"), execLog: join(home, "exec.log"),
  };
  await writeFile(folders.configFile, "{}", { mode: 0o600 });
  return folders;
};

const isAtOrInside = (folder: string, path: string): boolean => {
  const rel = relative(folder, path);
  return rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
};

/** The absolute recordFsUnder folder: below the home folder, and without the exec log in it. */
const recordedFolder = (folders: CliChildFolders, path: string): string => {
  const folder = resolve(path);
  if (folder === resolve(folders.home) || !isAtOrInside(folders.home, folder) || isAtOrInside(folder, folders.execLog)) {
    throw new Error("recordFsUnder must name a folder below the CLI child home that does not hold the exec log");
  }
  return folder;
};

/** The program, arguments, folder and env that start the CLI with `cliArgs` in `folders`. */
export const cliChildCommand = (
  folders: CliChildFolders, cliArgs: readonly string[], options: CliChildOptions = {},
): CliChildCommand => {
  const extra = options.env ?? {};
  for (const name of HELPER_VARIABLES) {
    if (Object.hasOwn(extra, name)) throw new Error(`The CLI child helper sets ${name}`);
  }
  const cwd = options.cwd ?? folders.home;
  const config = extra["SUBSWITCH_CONFIG"] ?? folders.configFile;
  const configPath = resolve(cwd, config);
  if (config !== "" && (configPath === resolve(folders.home) || !isAtOrInside(folders.home, configPath))) {
    throw new Error("SUBSWITCH_CONFIG must be empty or name a file in the CLI child home folder");
  }
  const temp = tmpdir();
  for (const name of FIXTURE_FOLDER_VARIABLES) {
    const value = extra[name];
    if (value === undefined) continue;
    const path = resolve(cwd, value);
    if (!isAtOrInside(folders.home, path) && !isAtOrInside(temp, path)) {
      throw new Error(`${name} must name a folder in the CLI child home or temporary root`);
    }
  }
  const allow = options.allowNodeArgs === undefined ? {} : { SUBSWITCH_TEST_EXEC_ALLOW: JSON.stringify(options.allowNodeArgs) };
  const watch = options.recordFsUnder === undefined ? {} : { SUBSWITCH_TEST_FS_WATCH: recordedFolder(folders, options.recordFsUnder) };
  return {
    file: process.execPath,
    args: ["--import", TSX, "--import", DENY_PRELOAD, CLI_ENTRY, ...cliArgs],
    cwd,
    env: {
      PATH: process.env["PATH"], TMPDIR: process.env["TMPDIR"], ...extra, SUBSWITCH_CONFIG: config,
      HOME: folders.home, XDG_CONFIG_HOME: folders.configHome, XDG_CACHE_HOME: folders.cacheHome,
      SUBSWITCH_TEST_EXEC_LOG: folders.execLog, ...allow, ...watch,
    },
  };
};

/** Run the CLI to its end and return its exit code and output. */
export const runCliChild = (
  folders: CliChildFolders, cliArgs: readonly string[], options: CliChildOptions & { readonly timeoutMs?: number } = {},
): Promise<CliChildResult> => {
  const command = cliChildCommand(folders, cliArgs, options);
  return new Promise((resolve, reject) => {
    execFile(command.file, command.args, {
      cwd: command.cwd, env: command.env, timeout: options.timeoutMs ?? 10_000, maxBuffer: 1024 * 1024,
      // The serve command handles SIGTERM as a normal shutdown.
      killSignal: "SIGKILL",
    }, (error, stdout, stderr) => {
      if (error === null) resolve({ code: 0, stdout, stderr });
      else if (!error.killed && typeof error.code === "number") resolve({ code: error.code, stdout, stderr });
      else reject(error);
    });
  });
};

/**
 * A config for a doctor child with loopback probes. The test process holds the port claim
 * until exit. Add more keys with `extra`.
 */
export const offlineDoctorConfig = async (extra: Readonly<Record<string, unknown>> = {}): Promise<Record<string, unknown>> => {
  const { port } = await reserveTestPort();
  const providers = isPlainObject(extra["providers"]) ? extra["providers"] : {};
  return {
    ...extra,
    port,
    anthropic: { baseUrl: "http://127.0.0.1:9" },
    providers: {
      codex: { baseUrl: "http://127.0.0.1:9/backend-api/codex" }, together: { baseUrl: "http://127.0.0.1:9/v1" }, ...providers,
    },
  };
};

/** The lines of the exec-deny preload log. "preload" first shows that the preload ran. */
export const readExecLog = async (folders: CliChildFolders): Promise<string[]> =>
  (await readFile(folders.execLog, "utf8")).split("\n").filter((line) => line !== "");
