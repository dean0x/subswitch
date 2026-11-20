import type { Stats } from "node:fs";
import { lstat, mkdir } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { xdgBaseDir } from "../config.js";
import { err, ok, type Result } from "../result.js";

export type StateDirFault = "state_folder_not_private" | "state_folder_unavailable";

/**
 * A folder is private when it is a real folder and not a symbolic link, has no group or
 * other access bits, and belongs to the user of this process. Give it an lstat result.
 */
export const isPrivateFolder = (stat: Stats): boolean => {
  const uid = process.getuid?.();
  return stat.isDirectory() && !stat.isSymbolicLink() && (stat.mode & 0o077) === 0 && (uid === undefined || stat.uid === uid);
};

/**
 * The private Subswitch state folder: `subswitch` under XDG_CACHE_HOME when that is an
 * absolute path, else under `<home>/.cache`, the root of the action control and limit
 * folders. It makes a missing folder with mode 0700 and refuses a folder that is not
 * private. It fails closed: a relative home or a folder it can not make or check gives
 * an error, never a path. The caller gives `env` and `home`, so a test names its own folder.
 */
export const subswitchStateDir = async (
  env: Readonly<Record<string, string | undefined>>,
  home: string,
): Promise<Result<string, StateDirFault>> => {
  if (!isAbsolute(home)) return err("state_folder_unavailable");
  const path = join(xdgBaseDir(env["XDG_CACHE_HOME"], join(home, ".cache")), "subswitch");
  try {
    await mkdir(path, { recursive: true, mode: 0o700 });
    return isPrivateFolder(await lstat(path)) ? ok(path) : err("state_folder_not_private");
  } catch {
    return err("state_folder_unavailable");
  }
};
