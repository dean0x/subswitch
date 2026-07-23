import tls from "node:tls";
import { createColors } from "picocolors";
import type { Config } from "./config.js";

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
    const body = JSON.parse(result.body) as { name?: unknown; version?: unknown };
    if (body.name === "subswitch" && typeof body.version === "string") {
      return { kind: "running", name: body.name, version: body.version };
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

export const makeLiveHttpGet = (): ProbeSubswitchDeps["httpGet"] => async (url) => {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(3_000) });
    const body = await res.text();
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

// ---------------------------------------------------------------------------
// High-level doctor runner (injectable for tests)
// ---------------------------------------------------------------------------

export interface DoctorIO {
  readonly write: (line: string) => void;
  readonly readAuthFile: (path: string) => Promise<string>;
  readonly httpGet: (url: string) => Promise<HttpGetResult>;
  readonly tlsConnect: (host: string, port: number) => Promise<TlsStatus>;
  readonly color: boolean;
}

/**
 * Run all doctor checks and write output to io.write.
 * Returns 0 if all checks passed, 1 if any check failed.
 */
export const runDoctor = async (
  config: Config,
  configPath: string,
  fileFound: boolean,
  io: DoctorIO,
): Promise<number> => {
  const pc = createColors(io.color);
  const pass = (text: string): string => pc.green(text);
  const failStr = (text: string): string => pc.red(text);
  let failures = 0;

  io.write("subswitch doctor");
  io.write(`  config:             ${configPath}${fileFound ? "" : " (defaults — file not found)"}`);
  io.write(`  port:               ${config.port}`);
  io.write(`  logLevel:           ${config.logLevel}`);
  io.write(`  anthropic.baseUrl:  ${config.anthropic.baseUrl}`);
  io.write(`  codex.baseUrl:      ${config.codex.baseUrl}`);
  io.write(`  codex.models:       ${config.codex.models.join(", ")}`);
  io.write(`  codex.authFile:     ${config.codex.authFile}`);

  try {
    const raw = await io.readAuthFile(config.codex.authFile);
    // Lazy import to avoid circular deps — inspectAuthFile lives in codex-auth.ts
    const { inspectAuthFile } = await import("./codex-auth.js");
    const inspection = inspectAuthFile(raw);
    if (!inspection.ok) {
      failures++;
      io.write(`  codex auth:         ${failStr(`INVALID (${inspection.error.message})`)}`);
    } else {
      const info = inspection.value;
      io.write(`  codex auth mode:    ${pass(info.authMode)}`);
      io.write(`  codex account:      ${info.accountIdSuffix}`);
      io.write(`  token expires:      ${info.accessTokenExpiresAt ?? "(no exp claim)"}`);
      io.write(`  last refresh:       ${info.lastRefresh ?? "(unknown)"}`);
    }
  } catch {
    failures++;
    io.write(`  codex auth:         ${failStr("UNAVAILABLE")} (cannot read auth file — run \`codex login\`)`);
    io.write("  note: the Anthropic leg works without codex auth; only configured codex models are affected");
  }

  const subswitchStatus = await probeSubswitch(config.port, { httpGet: io.httpGet });
  switch (subswitchStatus.kind) {
    case "running":
      io.write(`  subswitch running:      ${pass(`YES (version ${subswitchStatus.version})`)}`);
      break;
    case "connection_refused":
      failures++;
      io.write(`  subswitch running:      ${failStr("NO")} (port ${config.port} not in use — run \`subswitch serve\`)`);
      break;
    case "not_subswitch":
      failures++;
      io.write(`  subswitch running:      ${failStr("UNKNOWN")} (something else is on port ${config.port})`);
      break;
  }

  const anthropicHost = new URL(config.anthropic.baseUrl).hostname;
  const codexHost = new URL(config.codex.baseUrl).hostname;

  const anthropicTls = await probeTlsReachable(anthropicHost, { tlsConnect: io.tlsConnect });
  if (anthropicTls.kind === "reachable") {
    io.write(`  anthropic TLS:      ${pass(`OK (${anthropicHost})`)}`);
  } else {
    failures++;
    io.write(`  anthropic TLS:      ${failStr(`FAIL (${anthropicHost}: ${anthropicTls.message})`)}`);
  }

  const codexTls = await probeTlsReachable(codexHost, { tlsConnect: io.tlsConnect });
  if (codexTls.kind === "reachable") {
    io.write(`  codex TLS:          ${pass(`OK (${codexHost})`)}`);
  } else {
    failures++;
    io.write(`  codex TLS:          ${failStr(`FAIL (${codexHost}: ${codexTls.message})`)}`);
  }

  if (failures === 0) {
    io.write(pass("all checks passed"));
  } else {
    io.write(failStr(`${failures} problem${failures === 1 ? "" : "s"} found`));
  }

  return failures === 0 ? 0 : 1;
};
