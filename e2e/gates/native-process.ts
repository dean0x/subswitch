import { spawn } from "node:child_process";

export interface NativeProcessResult {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly failure?: "timeout" | "output_limit" | "spawn_error" | "cancelled";
  /** In-memory inspection only. Callers must emit allowlisted diagnostics. */
  readonly stdout: string;
  readonly stderr: string;
}

/** Own a dedicated process group so cancellation cannot target another native session. */
export function nativeProcess(command: string, args: string[], options: {
  cwd: string; env: NodeJS.ProcessEnv; timeoutMs?: number; maxBytes?: number; signal?: AbortSignal;
}): Promise<NativeProcessResult> {
  return new Promise((resolve) => {
    const group = process.platform !== "win32";
    const child = spawn(command, args, { cwd: options.cwd, env: options.env, detached: group, stdio: "pipe" });
    const stdout: Buffer[] = [], stderr: Buffer[] = [];
    let bytes = 0;
    let failure: NativeProcessResult["failure"];
    let force: ReturnType<typeof setTimeout> | undefined;
    const kill = (signal: NodeJS.Signals) => {
      try { if (group && child.pid) process.kill(-child.pid, signal); else child.kill(signal); }
      catch { /* Already exited. Never search for or kill other processes. */ }
    };
    const stop = (reason: NonNullable<NativeProcessResult["failure"]>) => {
      if (failure) return;
      failure = reason;
      kill("SIGTERM");
      force = setTimeout(() => kill("SIGKILL"), 500);
    };
    const timer = setTimeout(() => stop("timeout"), options.timeoutMs ?? 45000);
    const abort = () => stop("cancelled");
    options.signal?.addEventListener("abort", abort, { once: true });
    if (options.signal?.aborted) abort();
    const collect = (parts: Buffer[], chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > (options.maxBytes ?? 2 * 1024 * 1024)) { stop("output_limit"); return; }
      parts.push(chunk);
    };
    child.stdout.on("data", (chunk: Buffer) => collect(stdout, chunk));
    child.stderr.on("data", (chunk: Buffer) => collect(stderr, chunk));
    child.stdin.on("error", () => undefined);
    // Native CLIs may wait for stdin EOF even when the prompt is an argument.
    child.stdin.end();
    child.once("error", () => { failure = "spawn_error"; });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", abort);
      if (force) clearTimeout(force);
      // Clear any descendants that outlived the CLI wrapper, only in our group.
      if (group && child.pid) kill("SIGKILL");
      resolve({ code, signal, ...(failure ? { failure } : {}),
        stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8") });
    });
  });
}

export function isolatedNativeEnv(overrides: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (/^(CODEX_|OPENAI_|ANTHROPIC_|CLAUDE_|SUBSWITCH_|NODE_OPTIONS$)/.test(key)) delete env[key];
  }
  return { ...env, ...overrides };
}
