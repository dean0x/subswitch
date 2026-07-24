import tls from "node:tls";
import { createColors } from "picocolors";
import type { Config } from "./config.js";
import { isPlainObject } from "./init.js";

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

// Column width for the label portion of each output row. [F24]
const LABEL_WIDTH = 22;

/** Format one doctor output row with a consistent label column width. */
const row = (label: string, value: string): string => `  ${label}`.padEnd(LABEL_WIDTH) + value;

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

  if (failures === 0) {
    io.write(passStr("all checks passed"));
  } else {
    io.write(failStr(`${failures} problem${failures === 1 ? "" : "s"} found`));
  }

  return failures === 0 ? 0 : 1;
};
