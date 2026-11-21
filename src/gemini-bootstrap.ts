import { isUtf8 } from "node:buffer";
import { createHash } from "node:crypto";
import { abortable } from "./abortable.js";
import { decodeBody } from "./content-encoding.js";
import { GEMINI_BOOTSTRAP_PATH, GEMINI_DEFAULT_HOST } from "./gemini-constants.js";
import type { GeminiAccountBlockLatch } from "./gemini-errors.js";
import type { ProviderCredential } from "./provider-auth.js";
import { err, ok, type Result } from "./result.js";
import type { PrepareBodyError } from "./translated-leg.js";

const LOAD_CODE_ASSIST_URL = `https://${GEMINI_DEFAULT_HOST}${GEMINI_BOOTSTRAP_PATH}`;
const DEADLINE_MS = 10_000;
const MAX_WIRE_BYTES = 64 * 1024;
const MAX_DECODED_BYTES = 256 * 1024;
const MAX_LINEAGES = 16;
const DEADLINE = Symbol("Gemini bootstrap deadline");

// [D4] Replace the placeholder body with the qualified request fields.
const UNQUALIFIED_BOOTSTRAP_BODY = "{}";
// [D4] Replace this extractor with the qualified project field and schema.
const extractUnqualifiedProject = (_body: unknown): undefined => undefined;

const ERROR_CODES = [
  "account_blocked", "bootstrap_busy", "bootstrap_cancelled", "bootstrap_credential",
  "bootstrap_project", "bootstrap_response", "bootstrap_timeout", "bootstrap_transport",
] as const;
export const geminiPrepareErrorCodes: ReadonlySet<string> = new Set(ERROR_CODES);

export interface GeminiBootstrapDeps {
  readonly accountBlock: GeminiAccountBlockLatch;
  /** The transport must expose raw body bytes. Standard fetch can decode them before the cap. */
  readonly fetchRaw: typeof fetch;
  readonly clock: { readonly schedule: (onDeadline: () => void, delayMs: number) => () => void };
  /** The codec returns a validated project ID. Offline tests can supply a synthetic codec. */
  readonly extractProjectId?: (body: unknown) => string | undefined;
}

type Credential = ProviderCredential<"gemini">;
type ProjectResult = Result<string, PrepareBodyError>;
interface Flight {
  readonly kind: "flight";
  readonly controller: AbortController;
  readonly result: Promise<ProjectResult>;
  waiters: number;
}
type Entry = Flight | { readonly kind: "project"; readonly id: string };

const failed = (errorCode: (typeof ERROR_CODES)[number]) => err({ kind: "failed" as const, errorCode });

const accessToken = (credential: Credential): string | undefined => {
  const header = credential.authHeaders.authorization;
  return header?.startsWith("Bearer ") && header.length > 7 ? header.slice(7) : undefined;
};
const fingerprint = (access: string): string => createHash("sha256").update(access).digest("hex");

const discard = (body: Response["body"]): void => { void body?.cancel().catch(() => undefined); };

const readWire = async (response: Response, signal: AbortSignal): Promise<Buffer | undefined> => {
  if (response.body === null || Number(response.headers.get("content-length")) > MAX_WIRE_BYTES) {
    discard(response.body);
    return undefined;
  }
  const reader = response.body.getReader();
  const raw = Buffer.alloc(MAX_WIRE_BYTES);
  let size = 0;
  try {
    // Empty chunks also count. One-byte chunks at the byte limit still have one read for EOF.
    for (let n = 0; n <= MAX_WIRE_BYTES && !signal.aborted; n++) {
      const { done, value } = await abortable(reader.read(), signal);
      if (done) return raw.subarray(0, size);
      if (value.byteLength > MAX_WIRE_BYTES - size) return undefined;
      raw.set(value, size);
      size += value.byteLength;
    }
    return undefined;
  } finally {
    void reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
};

export const createGeminiBootstrap = ({ accountBlock, fetchRaw, clock,
  extractProjectId = extractUnqualifiedProject }: GeminiBootstrapDeps) => {
  const entries = new Map<string, Entry>();

  const exchange = async (access: string, signal: AbortSignal): Promise<ProjectResult> => {
    const response = await fetchRaw(LOAD_CODE_ASSIST_URL, {
      method: "POST", redirect: "error", signal, body: UNQUALIFIED_BOOTSTRAP_BODY,
      headers: { authorization: `Bearer ${access}`, "content-type": "application/json", "accept-encoding": "identity" },
    });
    if (signal.aborted) {
      discard(response.body);
      return failed("bootstrap_cancelled");
    }
    if (response.redirected || (response.status >= 300 && response.status < 400)) {
      discard(response.body);
      return failed("bootstrap_transport");
    }
    if (!response.ok) {
      discard(response.body);
      if (response.status === 401) return err({ kind: "unauthorized" });
      if (response.status === 403) {
        // No qualified reason parser exists yet. Treat every bootstrap 403 as an unknown 403.
        accountBlock.block();
        return failed("account_blocked");
      }
      return failed("bootstrap_response");
    }
    try {
      const raw = await readWire(response, signal);
      if (raw === undefined || signal.aborted) return failed("bootstrap_response");
      const decoded = await decodeBody(raw, response.headers.get("content-encoding") ?? undefined, MAX_DECODED_BYTES);
      if (signal.aborted || !isUtf8(decoded)) return failed("bootstrap_response");
      const body: unknown = JSON.parse(decoded.toString("utf8"));
      const project = extractProjectId(body);
      return project === undefined ? failed("bootstrap_project") : ok(project);
    } catch {
      return failed("bootstrap_response");
    }
  };

  const run = async (access: string, controller: AbortController): Promise<ProjectResult> => {
    const { signal } = controller;
    if (signal.aborted) return failed("bootstrap_cancelled");
    if (accountBlock.isBlocked()) return failed("account_blocked");
    const stopDeadline = clock.schedule(() => controller.abort(DEADLINE), DEADLINE_MS);
    try {
      const result = await abortable(exchange(access, signal), signal);
      return accountBlock.isBlocked() ? failed("account_blocked") : result;
    } catch {
      if (signal.reason === DEADLINE) return failed("bootstrap_timeout");
      if (signal.aborted) return failed("bootstrap_cancelled");
      return failed("bootstrap_transport");
    } finally {
      stopDeadline();
    }
  };

  const remove = (digest: string, entry: Entry): void => {
    entries.delete(digest);
    if (entry.kind === "flight") entry.controller.abort();
  };

  const makeRoom = (): boolean => {
    if (entries.size < MAX_LINEAGES) return true;
    for (const [digest, entry] of entries) {
      if (entry.kind === "project") {
        entries.delete(digest);
        return true;
      }
    }
    return false;
  };

  const start = (digest: string, access: string): Flight => {
    const controller = new AbortController();
    const result = Promise.resolve().then(() => run(access, controller)).then((loaded) => {
      if (entries.get(digest) === flight) {
        if (loaded.ok) entries.set(digest, { kind: "project", id: loaded.value });
        else entries.delete(digest);
      }
      return loaded;
    });
    const flight: Flight = { kind: "flight", controller, result, waiters: 0 };
    entries.set(digest, flight);
    return flight;
  };

  const loadProject = async (credential: Credential, signal: AbortSignal): Promise<ProjectResult> => {
    if (signal.aborted) return failed("bootstrap_cancelled");
    if (accountBlock.isBlocked()) return failed("account_blocked");
    const access = accessToken(credential);
    if (access === undefined) return failed("bootstrap_credential");
    const digest = fingerprint(access);
    const cached = entries.get(digest);
    if (cached?.kind === "project") return ok(cached.id);
    if (cached === undefined && !makeRoom()) return failed("bootstrap_busy");
    const flight = cached ?? start(digest, access);
    flight.waiters++;
    try {
      const loaded = await abortable(flight.result, signal);
      return accountBlock.isBlocked() ? failed("account_blocked") : loaded;
    } catch {
      return failed("bootstrap_cancelled");
    } finally {
      flight.waiters--;
      if (flight.waiters === 0 && entries.get(digest) === flight) remove(digest, flight);
    }
  };

  // The generate path calls this for a 401, 403 or project 4xx for this credential.
  const invalidate = (credential: Credential): void => {
    const access = accessToken(credential);
    if (access === undefined) return;
    const digest = fingerprint(access);
    const entry = entries.get(digest);
    if (entry !== undefined) remove(digest, entry);
  };

  return { loadProject, invalidate };
};
