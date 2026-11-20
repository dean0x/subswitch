/**
 * The one way a test starts a src/cli.ts child process. A source-text guard checks that no
 * other test file names the CLI entry file.
 *
 * The child gets a fresh folder from mkdtemp as HOME, with XDG_CONFIG_HOME and
 * XDG_CACHE_HOME in it, and SUBSWITCH_CONFIG names a "{}" file in it. So the child can not
 * read the real user configuration, credentials or state. The child env does not copy the
 * parent env: it has PATH, TMPDIR, the folder variables and the variables that the test
 * names. The exec-deny preload also runs in the child, so the child can not start a
 * program. A run-action test that must start its client command names it with
 * allowNodeArgs: the preload then starts only that command and refuses all other attempts.
 */
import { execFile } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const CLI_ENTRY = fileURLToPath(new URL("../../src/cli.ts", import.meta.url));
const TSX = import.meta.resolve("tsx");
const DENY_PRELOAD = new URL("./deny-exec-file.ts", import.meta.url).href;

/** The variables that only the helper sets. */
const HELPER_VARIABLES = [
  "HOME", "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "SUBSWITCH_TEST_EXEC_LOG", "SUBSWITCH_TEST_EXEC_ALLOW",
] as const;

export interface CliChildFolders {
  /** HOME: a fresh folder from mkdtemp. The test removes it. */
  readonly home: string;
  /** XDG_CONFIG_HOME: `<home>/.config`. */
  readonly configHome: string;
  /** XDG_CACHE_HOME: `<home>/.cache`. */
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
   * may be "" (no explicit file) or a path in the home folder.
   */
  readonly env?: Readonly<Record<string, string | undefined>>;
  /**
   * Allow-list mode of the exec-deny preload, for a run-action test that must start its client
   * command: the exact arguments of the one process.execPath command that the child may start.
   */
  readonly allowNodeArgs?: readonly string[];
}

export interface CliChildCommand {
  readonly file: string;
  readonly args: string[];
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
}

export interface CliChildResult {
  /** The exit code, or 1 when the child did not exit by itself. */
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** Make a fresh folder set for CLI children. */
export const cliChildFolders = async (): Promise<CliChildFolders> => {
  const home = await mkdtemp(join(tmpdir(), "subswitch-cli-child-"));
  const folders: CliChildFolders = {
    home, configHome: join(home, ".config"), cacheHome: join(home, ".cache"),
    configFile: join(home, "subswitch-test-config.json"), execLog: join(home, "exec.log"),
  };
  await writeFile(folders.configFile, "{}");
  return folders;
};

const isInside = (folder: string, path: string): boolean => {
  const rel = relative(folder, path);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
};

/** The program, arguments, folder and env that start the CLI with `cliArgs` in `folders`. */
export const cliChildCommand = (
  folders: CliChildFolders, cliArgs: readonly string[], options: CliChildOptions = {},
): CliChildCommand => {
  const extra = options.env ?? {};
  for (const name of HELPER_VARIABLES) {
    if (Object.hasOwn(extra, name)) throw new Error(`The CLI child helper sets ${name}`);
  }
  const config = extra["SUBSWITCH_CONFIG"] ?? folders.configFile;
  if (config !== "" && !isInside(folders.home, config)) {
    throw new Error("SUBSWITCH_CONFIG must be empty or name a file in the CLI child home folder");
  }
  const allow = options.allowNodeArgs === undefined ? {} : { SUBSWITCH_TEST_EXEC_ALLOW: JSON.stringify(options.allowNodeArgs) };
  return {
    file: process.execPath,
    args: ["--import", TSX, "--import", DENY_PRELOAD, CLI_ENTRY, ...cliArgs],
    cwd: options.cwd ?? folders.home,
    env: {
      PATH: process.env["PATH"], TMPDIR: process.env["TMPDIR"], ...extra, SUBSWITCH_CONFIG: config,
      HOME: folders.home, XDG_CONFIG_HOME: folders.configHome, XDG_CACHE_HOME: folders.cacheHome,
      SUBSWITCH_TEST_EXEC_LOG: folders.execLog, ...allow,
    },
  };
};

/** Run the CLI to its end and return its exit code and output. */
export const runCliChild = (
  folders: CliChildFolders, cliArgs: readonly string[], options: CliChildOptions & { readonly timeoutMs?: number } = {},
): Promise<CliChildResult> => {
  const command = cliChildCommand(folders, cliArgs, options);
  return new Promise((resolve) => {
    execFile(command.file, command.args, {
      cwd: command.cwd, env: command.env, timeout: options.timeoutMs ?? 10_000, maxBuffer: 1024 * 1024,
    }, (error, stdout, stderr) => {
      resolve({ code: error === null ? 0 : typeof error.code === "number" ? error.code : 1, stdout, stderr });
    });
  });
};

/** The lines of the exec-deny preload log. "preload" first shows that the preload ran. */
export const readExecLog = async (folders: CliChildFolders): Promise<string[]> =>
  (await readFile(folders.execLog, "utf8")).split("\n").filter((line) => line !== "");
