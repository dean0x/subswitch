import { constants } from "node:fs";
import { mkdir, open, rename, unlink, lstat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Logger } from "./logger.js";
import type { LimitObservation } from "./limit-observation.js";

const FILE_BYTES = 2 * 1024 * 1024;
const FILES = 4;
const RECORD_BYTES = 16 * 1024;
export function limitDirectory(
  port: number,
  env: NodeJS.ProcessEnv = process.env,
): string {
  return join(
    env["SUBSWITCH_LIMIT_DIR"] ??
      join(homedir(), ".cache", "subswitch", "limits"),
    String(port),
  );
}
/** Asynchronous bounded private artifacts. Disk failure never blocks inference. */
export class LimitRecorder {
  private pending = Promise.resolve();
  private queued = 0;
  private warned = false;
  private readonly tasks = new Set<Promise<void>>();
  constructor(
    readonly directory: string,
    private readonly logger: Logger,
  ) {}
  readonly record = (observation: LimitObservation): void => {
    const line = JSON.stringify(observation) + "\n";
    if (Buffer.byteLength(line) > RECORD_BYTES || this.queued >= 32) {
      this.warn("limit_recording_dropped");
      return;
    }
    this.queued++;
    this.pending = this.pending
      .then(() => this.append(line))
      .catch(() => this.warn("limit_recording_unavailable"))
      .finally(() => this.queued--);
  };
  private warn(code: string): void {
    if (this.warned) return;
    this.warned = true;
    try {
      this.logger.log("warn", code);
    } catch {
      /* Diagnostics remain optional. */
    }
  }
  private async append(line: string): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const directory = await lstat(this.directory);
    if (
      !directory.isDirectory() ||
      directory.isSymbolicLink() ||
      (process.getuid && directory.uid !== process.getuid()) ||
      directory.mode & 0o077
    )
      throw new Error("unsafe_limit_directory");
    const path = join(this.directory, "events.jsonl");
    let file: Awaited<ReturnType<typeof open>> | undefined = await open(
      path,
      constants.O_APPEND |
        constants.O_CREAT |
        constants.O_WRONLY |
        constants.O_NOFOLLOW,
      0o600,
    );
    try {
      const stat = await file.stat();
      if (
        !stat.isFile() ||
        stat.size > FILE_BYTES ||
        stat.nlink !== 1 ||
        stat.mode & 0o077 ||
        (process.getuid && stat.uid !== process.getuid())
      )
        throw new Error("unsafe_limit_file");
      if (stat.size + Buffer.byteLength(line) > FILE_BYTES) {
        await file.close();
        file = undefined;
        await unlink(
          join(this.directory, "events." + (FILES - 1) + ".jsonl"),
        ).catch((error) => {
          if (error.code !== "ENOENT") throw error;
        });
        for (let index = FILES - 2; index >= 0; index--) {
          const from = join(
            this.directory,
            index === 0 ? "events.jsonl" : "events." + index + ".jsonl",
          );
          await rename(
            from,
            join(this.directory, "events." + (index + 1) + ".jsonl"),
          ).catch((error) => {
            if (error.code !== "ENOENT") throw error;
          });
        }
        file = await open(
          path,
          constants.O_APPEND |
            constants.O_CREAT |
            constants.O_WRONLY |
            constants.O_NOFOLLOW,
          0o600,
        );
      }
      await file!.writeFile(line);
    } finally {
      await file?.close();
    }
  }
  readonly track = (task: Promise<void>): void => {
    this.tasks.add(task);
    void task.finally(() => this.tasks.delete(task)).catch(() => undefined);
  };
  async flush(): Promise<void> {
    await Promise.allSettled([...this.tasks]);
    await this.pending;
  }
}
export function withLimitRecorder(
  logger: Logger,
  recorder: LimitRecorder,
): Logger {
  return {
    log: (level, event, fields) => logger.log(level, event, fields),
    recordLimit: recorder.record,
    trackLimitTask: recorder.track,
  };
}
export async function readLimitObservations(
  directory: string,
): Promise<LimitObservation[]> {
  const records: LimitObservation[] = [];
  for (let index = FILES - 1; index >= 0; index--) {
    const path = join(
      directory,
      index === 0 ? "events.jsonl" : "events." + index + ".jsonl",
    );
    let file;
    try {
      file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    try {
      const stat = await file.stat();
      if (
        !stat.isFile() ||
        stat.nlink !== 1 ||
        stat.size > FILE_BYTES ||
        stat.mode & 0o077 ||
        (process.getuid && stat.uid !== process.getuid())
      )
        throw new Error("unsafe_limit_file");
      const buffer = Buffer.alloc(FILE_BYTES + 1);
      const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
      if (bytesRead > FILE_BYTES) throw new Error("limit_file_too_large");
      const text = buffer.subarray(0, bytesRead).toString("utf8");
      for (const line of text.split("\n")) {
        if (!line || Buffer.byteLength(line) > RECORD_BYTES) continue;
        try {
          const value = JSON.parse(line);
          if (
            value.schemaVersion === 1 &&
            value.source === "upstream-response" &&
            value.redacted === true
          )
            records.push(value);
        } catch {
          /* Interrupted final write is not a record. */
        }
      }
    } finally {
      await file.close();
    }
  }
  return records;
}
