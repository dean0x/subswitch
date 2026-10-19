import { mkdir, lstat, readFile, open, rename, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { RoutingError } from "./routing-types.js";

export const actionControlPath = (port: number): string =>
  join(
    homedir(),
    ".cache",
    "subswitch",
    "actions",
    String(port),
    "control.json",
  );
export async function publishActionControl(
  port: number,
  capability: string,
): Promise<() => Promise<void>> {
  const path = actionControlPath(port),
    directory = join(path, "..");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const stat = await lstat(directory);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    (stat.mode & 0o077) !== 0 ||
    (process.getuid && stat.uid !== process.getuid())
  )
    throw new RoutingError("action_control_directory_not_private", 503);
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    const file = await open(temporary, "wx", 0o600);
    try {
      await file.writeFile(
        JSON.stringify({
          schemaVersion: 1,
          pid: process.pid,
          port,
          capability,
        }),
      );
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(temporary, path);
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
  return async () => {
    const current = await readActionControl(port).catch(() => undefined);
    if (current?.capability === capability)
      await unlink(path).catch(() => undefined);
  };
}
export async function readActionControl(
  port: number,
): Promise<{ port: number; capability: string } | undefined> {
  const path = actionControlPath(port);
  let stat;
  try {
    stat = await lstat(path);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw e;
  }
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.size > 4096 ||
    (stat.mode & 0o077) !== 0 ||
    (process.getuid && stat.uid !== process.getuid())
  )
    throw new RoutingError("action_control_file_not_private", 503);
  const value = JSON.parse(await readFile(path, "utf8")) as {
    port?: unknown;
    capability?: unknown;
    pid?: unknown;
  };
  if (
    value.port !== port ||
    typeof value.capability !== "string" ||
    !/^[a-f0-9]{64}$/.test(value.capability) ||
    typeof value.pid !== "number" ||
    !Number.isSafeInteger(value.pid) ||
    value.pid < 1
  )
    throw new RoutingError("invalid_action_control_file", 503);
  try {
    process.kill(value.pid, 0);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return undefined;
    throw new RoutingError("action_control_owner_unavailable", 503);
  }
  return { port, capability: value.capability };
}
