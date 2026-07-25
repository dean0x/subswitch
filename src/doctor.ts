import tls from "node:tls";
import { readdir, readFile as fsReadFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve as pathResolve } from "node:path";
import { createColors } from "picocolors";
import type { Config } from "./config.js";
import { isPlainObject } from "./init.js";
import { MODEL_REGISTRY, formatModelsReport } from "./models.js";
import { checkAgentModels } from "./agent-scan.js";

// ---------------------------------------------------------------------------
// Discriminated-union result types
// ---------------------------------------------------------------------------

export type SubswitchStatus =
  | { readonly kind: "running"; readonly name: string; readonly version: string }
  | { readonly kind: "connection_refused" }
  | { readonly kind: "not_subswitch" };

export type TlsStatus =
  | { readonly kind: "reachable" }
  | { readonly kind: "unreachable"; readonly message: string };

// ---------------------------------------------------------------------------
// Injected-dependency interfaces (unit tests supply fakes; production wires real I/O)
// ---------------------------------------------------------------------------

export type HttpGetResult =
  | { readonly ok: true; readonly status: number; readonly body: string }
  | { readonly ok: false; readonly connectionRefused: true }
  | { readonly ok: false; readonly connectionRefused: false; readonly message: string };

export interface ProbeSubswitchDeps {
  readonly httpGet: (url: string) => Promise<HttpGetResult>;
}

export interface ProbeTlsDeps {
  readonly tlsConnect: (host: string, port: number) => Promise<TlsStatus>;
}

// ---------------------------------------------------------------------------
// Probes
// ---------------------------------------------------------------------------

/**
 * Probe whether subswitch is listening on `port`.
 *
 * Returns:
 * - "running"            — GET /__subswitch/health responded with the subswitch health shape
 * - "connection_refused" — nothing is listening on the port
 * - "not_subswitch"          — something else is on the port, or an unexpected response
 */
export const probeSubswitch = async (port: number, deps: ProbeSubswitchDeps): Promise<SubswitchStatus> => {
  const result = await deps.httpGet(`http://127.0.0.1:${port}/__subswitch/health`);
  if (!result.ok) {
    if (result.connectionRefused) return { kind: "connection_refused" };
    return { kind: "not_subswitch" };
  }
  if (result.status !== 200) return { kind: "not_subswitch" };
  try {
    const parsed: unknown = JSON.parse(result.body);
    if (isPlainObject(parsed) && parsed["name"] === "subswitch" && typeof parsed["version"] === "string") {
      return { kind: "running", name: parsed["name"] as string, version: parsed["version"] };
    }
    return { kind: "not_subswitch" };
  } catch {
    return { kind: "not_subswitch" };
  }
};

/**
 * Check TLS reachability of a host (port 443).
 * Issues no HTTP request, no auth, no API traffic — only a TLS handshake then immediate close.
 */
export const probeTlsReachable = async (host: string, deps: ProbeTlsDeps): Promise<TlsStatus> =>
  deps.tlsConnect(host, 443);

// ---------------------------------------------------------------------------
// Production implementations (wired by cli.ts; not imported by tests)
// ---------------------------------------------------------------------------

const isConnectionRefused = (e: unknown): boolean => {
  if (!(e instanceof Error)) return false;
  if (e.message.includes("ECONNREFUSED")) return true;
  const cause: unknown = (e as { cause?: unknown }).cause;
  if (cause instanceof AggregateError) {
    return cause.errors.some(
      (ce: unknown) => ce instanceof Error && ce.message.includes("ECONNREFUSED"),
    );
  }
  if (cause instanceof Error) return cause.message.includes("ECONNREFUSED");
  return false;
};

// Maximum bytes read from the health-endpoint body — the response is small JSON;
// cap prevents unbounded buffering if the port is occupied by a chatty service. [F49]
const MAX_BODY_BYTES = 8 * 1024;

export const makeLiveHttpGet = (): ProbeSubswitchDeps["httpGet"] => async (url) => {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(3_000) });
    let body = "";
    const { body: stream } = res;
    if (stream !== null) {
      const reader = stream.getReader();
      const chunks: Uint8Array[] = [];
      let totalBytes = 0;
      try {
        while (totalBytes < MAX_BODY_BYTES) {
          const { done, value } = await reader.read();
          if (done || value === undefined) break;
          chunks.push(value);
          totalBytes += value.byteLength;
        }
      } finally {
        reader.releaseLock();
      }
      body = new TextDecoder().decode(
        chunks.reduce<Uint8Array>((acc, chunk) => {
          const merged = new Uint8Array(acc.byteLength + chunk.byteLength);
          merged.set(acc);
          merged.set(chunk, acc.byteLength);
          return merged;
        }, new Uint8Array(0)),
      );
    }
    return { ok: true, status: res.status, body };
  } catch (e) {
    if (isConnectionRefused(e)) return { ok: false, connectionRefused: true };
    return { ok: false, connectionRefused: false, message: String(e) };
  }
};

export const makeLiveTlsConnect = (): ProbeTlsDeps["tlsConnect"] => (host, port) =>
  new Promise<TlsStatus>((resolve) => {
    const socket = tls.connect({ host, port, servername: host });
    socket.setTimeout(5_000);
    socket.once("secureConnect", () => {
      socket.destroy();
      resolve({ kind: "reachable" });
    });
    socket.once("error", (e) => {
      socket.destroy();
      resolve({ kind: "unreachable", message: e.message });
    });
    socket.once("timeout", () => {
      socket.destroy();
      resolve({ kind: "unreachable", message: "TLS connect timeout" });
    });
  });

/**
 * List all agent .md files under a directory recursively.
 * Returns an empty array when the directory is absent — missing dir is not an error. [F53]
 * Uses readdir with { recursive: true } — stable in Node 22 (ADR-004). [ADR-004]
 */
export const makeLiveListAgentFiles = (): DoctorIO["listAgentFiles"] => async (dir) => {
  // Resolve to absolute here in the factory (not in runDoctor) so that a relative
  // project dir (".claude/agents") and the absolute user dir ("~/. claude/agents")
  // produce identical path strings when they point to the same physical location —
  // enabling Set-based deduplication in runDoctor to fire correctly. [ADR-004]
  const absDir = pathResolve(dir);
  try {
    const entries = await readdir(absDir, { recursive: true });
    return (entries as string[])
      .filter((e) => e.endsWith(".md"))
      .map((e) => join(absDir, e));
  } catch {
    // Missing or unreadable directory → empty list, not an error.
    return [];
  }
};

/**
 * Read a text file for frontmatter scanning.
 */
export const makeLiveReadTextFile = (): DoctorIO["readTextFile"] => async (path) =>
  fsReadFile(path, "utf8");

// ---------------------------------------------------------------------------
// High-level doctor runner (injectable for tests)
// ---------------------------------------------------------------------------

export interface DoctorIO {
  readonly write: (line: string) => void;
  readonly readAuthFile: (path: string) => Promise<string>;
  readonly httpGet: (url: string) => Promise<HttpGetResult>;
  readonly tlsConnect: (host: string, port: number) => Promise<TlsStatus>;
  readonly color: boolean;
  /** List all .md files under an agent directory. Returns [] when directory absent. */
  readonly listAgentFiles: (dir: string) => Promise<readonly string[]>;
  /** Read a file's text content for frontmatter scanning. */
  readonly readTextFile: (path: string) => Promise<string>;
}

// Column width for the label portion of each output row. [F24]
const LABEL_WIDTH = 22;

/** Format one doctor output row with a consistent label column width. */
const row = (label: string, value: string): string => `  ${label}`.padEnd(LABEL_WIDTH) + value;

/**
 * Run all doctor checks and write output to io.write.
 * Returns 0 if all checks passed, 1 if any check failed.
 *
 * @param codexModelsPinned - When true, emit an informational nudge encouraging
 *   family aliases instead of pinned canonical ids. Trailing-defaulted so the
 *   seven existing runDoctor(...) call sites in doctor.test.ts compile untouched.
 */
export const runDoctor = async (
  config: Config,
  configPath: string,
  fileFound: boolean,
  io: DoctorIO,
  codexModelsPinned = false,
): Promise<number> => {
  const pc = createColors(io.color);
  const passStr = (text: string): string => pc.green(text);
  const failStr = (text: string): string => pc.red(text);
  let failures = 0;

  io.write("subswitch doctor");
  // Config-file detection is informational — a missing config file uses defaults and does
  // not increment the failure count, because defaults produce a working proxy. [F53]
  io.write(row("config:", `${configPath}${fileFound ? "" : " (defaults — file not found)"}`));
  io.write(row("port:", String(config.port)));
  io.write(row("logLevel:", config.logLevel));
  io.write(row("anthropic.baseUrl:", config.anthropic.baseUrl));
  io.write(row("codex.baseUrl:", config.codex.baseUrl));
  io.write(row("codex.models:", config.codex.models.join(", ")));

  // Alias table — shows effective alias → canonical mapping for the current config.
  const routable = new Set(config.codex.models);
  const aliasLines = formatModelsReport({
    registry: MODEL_REGISTRY,
    routable,
    overrides: config.codex.aliases,
  });
  for (const line of aliasLines) {
    io.write(`    ${line}`);
  }

  // Alias nudge — informational: suggest floating with aliases instead of pinned ids.
  if (codexModelsPinned) {
    io.write(
      row("aliases:", pc.dim("consider using family aliases (sol, terra, luna) — they auto-track the latest generation")),
    );
  }

  io.write(row("codex.authFile:", config.codex.authFile));

  try {
    const raw = await io.readAuthFile(config.codex.authFile);
    // Lazy import to avoid circular deps — inspectAuthFile lives in codex-auth.ts
    const { inspectAuthFile } = await import("./codex-auth.js");
    const inspection = inspectAuthFile(raw);
    if (!inspection.ok) {
      failures++;
      io.write(row("codex auth:", failStr(`INVALID (${inspection.error.message})`)));
    } else {
      const info = inspection.value;
      io.write(row("codex auth mode:", passStr(info.authMode)));
      io.write(row("codex account:", info.accountIdSuffix));
      io.write(row("token expires:", info.accessTokenExpiresAt ?? "(no exp claim)"));
      io.write(row("last refresh:", info.lastRefresh ?? "(unknown)"));
    }
  } catch {
    failures++;
    io.write(row("codex auth:", failStr("UNAVAILABLE") + ` (cannot read auth file — run \`codex login\`)`));
    io.write("  note: the Anthropic leg works without codex auth; only configured codex models are affected");
  }

  // Run all three network probes in parallel; write results in the fixed output order below. [F28/F5]
  const anthropicHost = new URL(config.anthropic.baseUrl).hostname;
  const codexHost = new URL(config.codex.baseUrl).hostname;

  const [subswitchStatus, anthropicTls, codexTls] = await Promise.all([
    probeSubswitch(config.port, { httpGet: io.httpGet }),
    probeTlsReachable(anthropicHost, { tlsConnect: io.tlsConnect }),
    probeTlsReachable(codexHost, { tlsConnect: io.tlsConnect }),
  ]);

  // Write subswitch probe result
  switch (subswitchStatus.kind) {
    case "running":
      io.write(row("subswitch running:", passStr(`YES (version ${subswitchStatus.version})`)));
      break;
    case "connection_refused":
      failures++;
      io.write(row("subswitch running:", failStr("NO") + ` (port ${config.port} not in use — run \`subswitch serve\`)`));
      break;
    case "not_subswitch":
      failures++;
      io.write(row("subswitch running:", failStr("UNKNOWN") + ` (something else is on port ${config.port})`));
      break;
  }

  // Write TLS results using a shared helper to eliminate duplication. [F28]
  const checkTls = (label: string, host: string, status: TlsStatus): void => {
    if (status.kind === "reachable") {
      io.write(row(`${label}:`, passStr(`OK (${host})`)));
    } else {
      failures++;
      io.write(row(`${label}:`, failStr(`FAIL (${host}: ${status.message})`)));
    }
  };

  checkTls("anthropic TLS", anthropicHost, anthropicTls);
  checkTls("codex TLS", codexHost, codexTls);

  // Agent frontmatter scan — check both project and user-level agent directories.
  // A missing directory resolves to an empty list — never an error. [F53]
  const projectAgentsDir = join(".", ".claude", "agents");
  const userAgentsDir = join(homedir(), ".claude", "agents");

  const [projectFiles, userFiles] = await Promise.all([
    io.listAgentFiles(projectAgentsDir),
    io.listAgentFiles(userAgentsDir),
  ]);

  // Read all discovered agent files (cap read errors to per-file; don't abort the scan).
  // Deduplicate: the two directories are the same path when doctor runs from $HOME,
  // which would otherwise report every finding twice and double-count failures.
  // Normalize each returned path to absolute (via pathResolve) before deduplication
  // so that a relative project path and an absolute user path for the same file
  // collapse to one entry in the Set — mirrors the factory-level resolution in
  // makeLiveListAgentFiles and provides belt-and-suspenders protection for any
  // injected fake that returns a mix of relative and absolute paths.
  const allPaths = [...new Set([...projectFiles, ...userFiles].map((p) => pathResolve(p)))];
  const fileTexts = await Promise.all(
    allPaths.map(async (path) => {
      try {
        const text = await io.readTextFile(path);
        return { path, text };
      } catch {
        // Unreadable file → treat as empty (no frontmatter model).
        return { path, text: "" };
      }
    }),
  );

  const agentFindings = checkAgentModels(fileTexts, routable, config.codex.aliases);

  // Label the first finding row; blank-label subsequent rows to avoid N identical "agent model:"
  // labels in the columnar output when multiple agents are misconfigured.
  let firstAgentFinding = true;
  for (const finding of agentFindings) {
    const label = firstAgentFinding ? "agent model:" : "";
    firstAgentFinding = false;
    if (finding.kind === "unresolvable") {
      // Unresolvable model → will silently 404 on the Codex leg. This is a failure.
      failures++;
      io.write(
        row(label, failStr(`FAIL`) + ` ${finding.file}: model "${finding.model}" is not a known id or alias`),
      );
    } else {
      // Excluded from narrowed codex.models — informational only. [F53]
      io.write(
        row(label, pc.dim(`info`) + ` ${finding.file}: model "${finding.model}" resolves to "${finding.canonical}" but is not in codex.models`),
      );
    }
  }

  if (failures === 0) {
    io.write(passStr("all checks passed"));
  } else {
    io.write(failStr(`${failures} problem${failures === 1 ? "" : "s"} found`));
  }

  return failures === 0 ? 0 : 1;
};
