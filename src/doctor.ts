import tls from "node:tls";

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
