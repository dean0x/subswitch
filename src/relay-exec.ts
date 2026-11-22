import { execFile, spawn, type ExecFileException } from "node:child_process";
import type { SpawnRelay } from "./relay-detach.js";
import { LAUNCHCTL_PATH, type LaunchctlRunner } from "./relay-service.js";
import { err, ok, type Result } from "./result.js";

export const spawnRelay: SpawnRelay = (executable, argv, options) => {
  try {
    return ok(spawn(executable, argv, { ...options, shell: false }));
  } catch {
    return err("child_exited");
  }
};

export function launchctlResult(error: ExecFileException | null): Result<number, string> {
  if (error === null) return ok(0);
  return typeof error.code === "number" ? ok(error.code) : err("launchctl did not complete");
}

export const runLaunchctl: LaunchctlRunner = async (_path, args, timeout) => {
  try {
    return await new Promise<Result<number, string>>((resolve) => {
      execFile(LAUNCHCTL_PATH, [...args], { shell: false, env: {}, timeout, killSignal: "SIGKILL", maxBuffer: 64 * 1024 }, (error) => {
        resolve(launchctlResult(error));
      });
    });
  } catch {
    return err("could not run launchctl");
  }
};
