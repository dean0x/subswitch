import { spawn } from "node:child_process";
import type { SpawnRelay } from "./relay-detach.js";
import { err, ok } from "./result.js";

export const spawnRelay: SpawnRelay = (executable, argv, options) => {
  try {
    return ok(spawn(executable, argv, { ...options, shell: false }));
  } catch {
    return err("child_exited");
  }
};
