/**
 * Concurrent-upload memory bench — PEAK in-flight RSS of an ISOLATED proxy process.
 *
 * Run:
 *   npm run bench:memory
 *   CONCURRENCY=16 BODY_MIB=8 npm run bench:memory
 *
 * ---------------------------------------------------------------------------
 * MEASURED NUMBERS — 2026-08-19, Apple M1 Max (darwin-arm64, 64 GiB), Node v22.22.3
 * ---------------------------------------------------------------------------
 * CONCURRENCY=32, BODY_MIB=32 (= the configured `limits.maxBodyBytes`), all 32 uploads
 * parked at the fake origin, proxy alone in a child process, 25 ms in-flight sampling,
 * no forced GC:
 *
 *   peak RSS              2200.2 MiB   (baseline 82.3 MiB, delta +2117.9 MiB)
 *   peak heapUsed          141.3 MiB   (delta +127.5 MiB)
 *   peak external         1093.8 MiB   (delta +1088.0 MiB)
 *   per in-flight request   66.2 MiB RSS, 4.0 MiB heap
 *   amplification            2.07x over wire bytes
 *
 * Six consecutive runs at these settings: 66.2 / 64.1 / 64.0 / 65.1 / 64.1 / 64.1 MiB
 * per request (2.00x–2.07x). At CONCURRENCY=16 BODY_MIB=8 it is 2.06x–2.20x — slightly
 * higher because the fixed per-connection overhead is amortized over fewer bytes. Cost
 * is otherwise linear in body size, which is why the ceiling below is a multiplier.
 *
 * At that cost, 2 GiB of RSS growth is crossed at ~31–32 concurrent requests, every one
 * of them at the full 32 MiB `limits.maxBodyBytes`. The previous version of this header
 * claimed ~683; that figure came from a snapshot taken after `Promise.allSettled` and
 * after a `global.gc()` that was a silent no-op without `--expose-gc`, in a process
 * shared with its own load generator, using a payload that never parsed as JSON — it
 * measured the post-collection trough and labelled it the peak (PF-025).
 *
 * On amplification: it is ~2x here, not the ~3x reported from shared-process harnesses.
 * The buffered chunk list and the `Buffer.concat` result are both live at the same
 * moment in `bufferBody` (src/server.ts), and the UTF-8 string plus the parsed object
 * graph supply the heap term (+4.0 MiB/request). It is decidedly not 1x, so wire size
 * alone is not the memory cost.
 *
 * WHAT THIS BENCH DOES AND DOES NOT JUSTIFY. It does not justify the absence of an
 * aggregate in-flight bound; that is a deployment-envelope decision recorded in
 * ADR-010. subswitch is a single local user running tens of concurrent agents, real
 * Claude Code request bodies are orders of magnitude below the 32 MiB ceiling, and
 * `limits.maxBodyBytes` bounds each request individually — there is deliberately no
 * aggregate bound. The numbers above are the worst case (every agent simultaneously
 * at the ceiling), not the expected case, and ADR-010 requires any bound to be
 * justified by measurement at the actual deployment shape rather than by a benchmark
 * headline. What this bench IS for: catching regressions in per-request memory cost.
 * A change that adds one more full copy of the body shows up here as the amplification
 * moving past the ceiling and the process exiting non-zero.
 * ---------------------------------------------------------------------------
 *
 * Method (each point exists because the previous version of this file got it wrong —
 * see PF-025):
 *
 *  1. The proxy runs in a CHILD PROCESS (this same file, re-entered with
 *     `--proxy-child`). The load generator and the fake origin live in the parent.
 *     `process.memoryUsage()` sampled in the child therefore measures the relay and
 *     nothing else — no load-generator buffers, no origin buffers.
 *  2. Every upload is PARKED at the fake origin: the origin reads each request body
 *     to completion and holds the `ServerResponse` without answering. Nothing is
 *     released until the measurement is taken, so all N bodies are genuinely
 *     simultaneous.
 *  3. The child samples `process.memoryUsage()` on a 25 ms interval for the whole
 *     window and keeps the running MAXIMUM. The number reported is a peak, not a
 *     post-settle snapshot.
 *  4. No `global.gc()` anywhere. Peak sampling makes it unnecessary, and a forced GC
 *     immediately before a snapshot is precisely how the old numbers were produced.
 *     `--expose-gc` is not required and not used.
 *  5. The payload is a real Anthropic messages request
 *     (`{"model":…,"max_tokens":…,"messages":[{"role":"user","content":"<padding>"}]}`)
 *     sized so the wire body hits the target exactly, so `JSON.parse`, the UTF-8
 *     string materialization and the parsed object graph — the allocations that
 *     dominate V8 heap on the real path — are all exercised.
 *
 * Environment knobs:
 *
 *   CONCURRENCY          simultaneous in-flight uploads          (default 32)
 *   BODY_MIB             wire body size per request, MiB         (default: the
 *                        configured `limits.maxBodyBytes`, i.e. run at the ceiling)
 *   CEILING_MIB_PER_REQ  fail the run above this peak RSS cost   (default:
 *                        BODY_MIB × PEAK_AMPLIFICATION_CEILING, see below)
 *
 * Exit code: 0 only if every request returned 200 after release AND the measured
 * peak RSS per in-flight request is at or below the ceiling. Anything else exits 1.
 *
 * This file lives under test/tools/ so `tsc --noEmit` typechecks it, but outside
 * test/unit/ and test/integration/ so the `npm test` globs do NOT pick it up. The
 * filename ends in .bench.ts, not .test.ts, for the same reason. It is deliberately
 * not wired into CI: it allocates gigabytes.
 */

import http from "node:http";
import os from "node:os";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { fork, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { type Result, ok, err } from "../../src/result.js";
import { createProxyServer, listenServer, buildDeps } from "../../src/server.js";
import { loadConfig } from "../../src/config.js";

const MIB = 1024 * 1024;

/** Sampling interval for the in-flight memory sampler. Must stay ≤ 50 ms. */
const SAMPLE_INTERVAL_MS = 25;

/**
 * Default ceiling, expressed as a multiple of the wire body size.
 *
 * Measured amplification is 2.00x–2.07x across six runs (see the header block); 3.0x
 * leaves ~45% margin — loose enough to absorb machine and allocator variance, tight
 * enough that one additional full copy of the body (which would land near 3.1x) fails
 * the run. It is a multiplier rather than a fixed MiB figure so the bench keeps its
 * teeth at any BODY_MIB. Override the absolute value with CEILING_MIB_PER_REQ.
 */
const PEAK_AMPLIFICATION_CEILING = 3.0;

/** Hard upper bound on how long the child proxy may live if the parent vanishes. */
const CHILD_MAX_LIFETIME_MS = 15 * 60 * 1000;

/** Bound on waiting for all N uploads to arrive and park at the origin. */
const PARK_ARRIVAL_TIMEOUT_MS = 180_000;

/** How long to hold the fully-parked window so the sampler observes it. */
const PARK_HOLD_MS = 500;

const CHILD_ARG = "--proxy-child";
const ORIGIN_PORT_ENV = "SUBSWITCH_BENCH_ORIGIN_PORT";

// ---------------------------------------------------------------------------
// IPC protocol — parsed at the boundary in both directions, never cast.
// ---------------------------------------------------------------------------

interface MemorySnapshot {
  readonly rss: number;
  readonly heapUsed: number;
  readonly external: number;
}

type ParentMessage =
  | { readonly kind: "arm" }
  | { readonly kind: "report" }
  | { readonly kind: "shutdown" };

type ChildMessage =
  | { readonly kind: "ready"; readonly port: number; readonly maxBodyBytes: number }
  | { readonly kind: "armed" }
  | {
      readonly kind: "report";
      readonly baseline: MemorySnapshot;
      readonly peak: MemorySnapshot;
      readonly samples: number;
    }
  | { readonly kind: "fatal"; readonly message: string };

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null ? (value as Record<string, unknown>) : undefined;

const asSnapshot = (value: unknown): MemorySnapshot | undefined => {
  const r = asRecord(value);
  if (r === undefined) return undefined;
  const { rss, heapUsed, external } = r;
  if (typeof rss !== "number" || typeof heapUsed !== "number" || typeof external !== "number") return undefined;
  return { rss, heapUsed, external };
};

const parseParentMessage = (raw: unknown): ParentMessage | undefined => {
  const r = asRecord(raw);
  if (r === undefined) return undefined;
  if (r["kind"] === "arm") return { kind: "arm" };
  if (r["kind"] === "report") return { kind: "report" };
  if (r["kind"] === "shutdown") return { kind: "shutdown" };
  return undefined;
};

const parseChildMessage = (raw: unknown): ChildMessage | undefined => {
  const r = asRecord(raw);
  if (r === undefined) return undefined;
  if (r["kind"] === "ready") {
    const { port, maxBodyBytes } = r;
    if (typeof port !== "number" || typeof maxBodyBytes !== "number") return undefined;
    return { kind: "ready", port, maxBodyBytes };
  }
  if (r["kind"] === "armed") return { kind: "armed" };
  if (r["kind"] === "report") {
    const baseline = asSnapshot(r["baseline"]);
    const peak = asSnapshot(r["peak"]);
    const samples = r["samples"];
    if (baseline === undefined || peak === undefined || typeof samples !== "number") return undefined;
    return { kind: "report", baseline, peak, samples };
  }
  if (r["kind"] === "fatal") {
    const message = r["message"];
    return { kind: "fatal", message: typeof message === "string" ? message : "unknown" };
  }
  return undefined;
};

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

const formatMiB = (bytes: number): string => `${(bytes / MIB).toFixed(1)} MiB`;

const formatDelta = (bytes: number): string => `${bytes >= 0 ? "+" : ""}${formatMiB(bytes)}`;

const snapshot = (): MemorySnapshot => {
  const m = process.memoryUsage();
  return { rss: m.rss, heapUsed: m.heapUsed, external: m.external };
};

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Poll `condition` until true or the deadline passes. Bounded by construction. */
const pollUntil = async (condition: () => boolean, timeoutMs: number, intervalMs = 20): Promise<boolean> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) return true;
    await sleep(intervalMs);
  }
  return condition();
};

// ===========================================================================
// CHILD ROLE — the proxy under measurement. Nothing else runs in this process.
// ===========================================================================

const runProxyChild = async (): Promise<void> => {
  const send = (message: ChildMessage): void => {
    process.send?.(message);
  };
  const fatal = (message: string): void => {
    send({ kind: "fatal", message });
    process.exit(1);
  };

  const originPort = Number(process.env[ORIGIN_PORT_ENV]);
  if (!Number.isInteger(originPort) || originPort <= 0) {
    fatal(`${ORIGIN_PORT_ENV} is not a valid port`);
    return;
  }

  // Same composition the CLI uses: loadConfig → buildDeps → createProxyServer → listenServer.
  const configResult = loadConfig({
    configPath: "inline-bench.json",
    readFile: () =>
      JSON.stringify({
        logLevel: "error",
        anthropic: {
          baseUrl: `http://127.0.0.1:${originPort}`,
          allowInsecureBaseUrl: true,
          connectTimeoutMs: 30_000,
        },
      }),
    env: {},
  });
  if (!configResult.ok) {
    fatal(`loadConfig failed: ${configResult.error.message}`);
    return;
  }
  const { config } = configResult.value;

  const depsResult = buildDeps(config);
  if (!depsResult.ok) {
    fatal(`buildDeps failed: ${depsResult.error}`);
    return;
  }

  const server = createProxyServer(depsResult.value);
  const listenResult = await listenServer(server, 0, "127.0.0.1");
  if (!listenResult.ok) {
    fatal(`listenServer failed: ${listenResult.error.message}`);
    return;
  }
  const address = server.address();
  if (address === null || typeof address === "string") {
    fatal("proxy server has no TCP address");
    return;
  }
  const port = (address satisfies AddressInfo).port;

  // In-flight sampler: running maximum over the whole window, never a single snapshot.
  let baseline = snapshot();
  let peak = baseline;
  let samples = 0;
  const sampler = setInterval(() => {
    const s = snapshot();
    samples += 1;
    peak = {
      rss: Math.max(peak.rss, s.rss),
      heapUsed: Math.max(peak.heapUsed, s.heapUsed),
      external: Math.max(peak.external, s.external),
    };
  }, SAMPLE_INTERVAL_MS);

  const shutdown = (code: number): void => {
    clearInterval(sampler);
    server.closeAllConnections();
    server.close(() => process.exit(code));
  };

  const lifetime = setTimeout(() => shutdown(3), CHILD_MAX_LIFETIME_MS);
  lifetime.unref();

  process.on("message", (raw: unknown) => {
    const message = parseParentMessage(raw);
    if (message === undefined) return;
    switch (message.kind) {
      case "arm":
        baseline = snapshot();
        peak = baseline;
        samples = 0;
        send({ kind: "armed" });
        return;
      case "report":
        send({ kind: "report", baseline, peak, samples });
        return;
      case "shutdown":
        shutdown(0);
        return;
      default: {
        const _exhaustive: never = message;
        void _exhaustive;
        return;
      }
    }
  });

  // Parent gone: never linger holding a port.
  process.on("disconnect", () => shutdown(0));

  send({ kind: "ready", port, maxBodyBytes: config.limits.maxBodyBytes });
};

// ===========================================================================
// PARENT ROLE — fake origin + load generator. Its allocations never touch the child.
// ===========================================================================

interface ParkingOrigin {
  readonly port: number;
  /** Requests whose body has fully arrived and whose response is being withheld. */
  readonly arrivedCount: number;
  releaseAll(): void;
  close(): Promise<void>;
}

/**
 * Fake origin that parks every arriving request until releaseAll().
 *
 * Mirrors `startParkingUpstream` in test/integration/concurrency.test.ts, with one
 * deliberate difference: request chunks are counted and discarded rather than
 * retained. The origin must not hold N × BODY_MIB of its own — it shares a process
 * with the load generator, and a bench that OOMs its own harness measures nothing.
 */
const startParkingOrigin = async (): Promise<ParkingOrigin> => {
  const parked: ServerResponse[] = [];
  const server = http.createServer((req: IncomingMessage, res: ServerResponse) => {
    req.on("data", () => {
      /* drain without retaining */
    });
    req.on("end", () => {
      parked.push(res);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  return {
    port: address.port,
    get arrivedCount() {
      return parked.length;
    },
    releaseAll() {
      for (const res of parked.splice(0)) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ type: "message", role: "assistant", content: [] }));
      }
    },
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
};

/**
 * A real Anthropic messages body of exactly `targetBytes` wire bytes.
 *
 * The padding is ASCII, so no JSON escaping expands it and the byte count is exact —
 * asserted below, because a body that silently misses the target would misreport
 * per-request cost.
 */
const buildMessagesBody = (targetBytes: number): Result<Buffer, string> => {
  const envelope = (content: string): string =>
    JSON.stringify({
      model: "claude-3-5-sonnet-20241022",
      max_tokens: 1024,
      messages: [{ role: "user", content }],
    });
  const overhead = Buffer.byteLength(envelope(""), "utf8");
  if (targetBytes < overhead) {
    return err(`body target ${targetBytes} B is smaller than the ${overhead} B JSON envelope`);
  }
  const body = Buffer.from(envelope("a".repeat(targetBytes - overhead)), "utf8");
  if (body.length !== targetBytes) {
    return err(`body sizing failed: wanted ${targetBytes} B, built ${body.length} B`);
  }
  return ok(body);
};

const postMessages = (agent: http.Agent, port: number, body: Buffer): Promise<Result<number, string>> =>
  new Promise((resolve) => {
    const request = http.request(
      {
        host: "127.0.0.1",
        port,
        method: "POST",
        path: "/v1/messages",
        agent,
        headers: {
          "content-type": "application/json",
          authorization: "Bearer bench",
          "content-length": String(body.length),
        },
      },
      (response) => {
        response.resume();
        response.on("end", () => resolve(ok(response.statusCode ?? 0)));
      },
    );
    request.on("error", (e: Error) => resolve(err(e.message)));
    request.end(body);
  });

// ---------------------------------------------------------------------------
// Child link: strictly request/response, every wait bounded.
// ---------------------------------------------------------------------------

interface ChildLink {
  send(message: ParentMessage): void;
  next(timeoutMs: number): Promise<Result<ChildMessage, string>>;
}

const createChildLink = (child: ChildProcess): ChildLink => {
  const queue: ChildMessage[] = [];
  let waiter: ((r: Result<ChildMessage, string>) => void) | undefined;
  const deliver = (r: Result<ChildMessage, string>): void => {
    const w = waiter;
    waiter = undefined;
    if (w !== undefined) {
      w(r);
      return;
    }
    if (r.ok) queue.push(r.value);
  };
  child.on("message", (raw: unknown) => {
    const parsed = parseChildMessage(raw);
    if (parsed !== undefined) deliver(ok(parsed));
  });
  child.on("exit", (code) => deliver(err(`proxy child exited early with code ${String(code)}`)));
  child.on("error", (e: Error) => deliver(err(`proxy child error: ${e.message}`)));

  return {
    send: (message) => {
      child.send(message);
    },
    next: (timeoutMs) =>
      new Promise((resolve) => {
        const queued = queue.shift();
        if (queued !== undefined) {
          resolve(ok(queued));
          return;
        }
        const timer = setTimeout(() => {
          waiter = undefined;
          resolve(err(`timed out after ${timeoutMs} ms waiting for the proxy child`));
        }, timeoutMs);
        waiter = (r) => {
          clearTimeout(timer);
          resolve(r);
        };
      }),
  };
};

const numberFromEnv = (name: string, fallback: number): Result<number, string> => {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return ok(fallback);
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return err(`${name} must be a positive number, got "${raw}"`);
  return ok(parsed);
};

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const runBench = async (): Promise<number> => {
  const concurrencyResult = numberFromEnv("CONCURRENCY", 32);
  if (!concurrencyResult.ok) {
    console.error(concurrencyResult.error);
    return 1;
  }
  const concurrency = Math.floor(concurrencyResult.value);

  const origin = await startParkingOrigin();
  const child = fork(fileURLToPath(import.meta.url), [CHILD_ARG], {
    env: { ...process.env, [ORIGIN_PORT_ENV]: String(origin.port) },
    stdio: ["ignore", "inherit", "inherit", "ipc"],
  });
  const link = createChildLink(child);

  const finish = async (code: number): Promise<number> => {
    link.send({ kind: "shutdown" });
    await sleep(150);
    if (child.exitCode === null) child.kill("SIGKILL");
    await origin.close();
    return code;
  };

  const ready = await link.next(60_000);
  if (!ready.ok || ready.value.kind !== "ready") {
    console.error(!ready.ok ? ready.error : `proxy child failed: ${JSON.stringify(ready.value)}`);
    return finish(1);
  }
  const { port: proxyPort, maxBodyBytes } = ready.value;

  // Default body size IS the configured ceiling: run at limits.maxBodyBytes.
  const bodyMibResult = numberFromEnv("BODY_MIB", maxBodyBytes / MIB);
  if (!bodyMibResult.ok) {
    console.error(bodyMibResult.error);
    return finish(1);
  }
  const bodyMib = bodyMibResult.value;
  const bodyBytes = Math.round(bodyMib * MIB);

  const ceilingResult = numberFromEnv("CEILING_MIB_PER_REQ", bodyMib * PEAK_AMPLIFICATION_CEILING);
  if (!ceilingResult.ok) {
    console.error(ceilingResult.error);
    return finish(1);
  }
  const ceilingMiB = ceilingResult.value;

  const bodyResult = buildMessagesBody(bodyBytes);
  if (!bodyResult.ok) {
    console.error(bodyResult.error);
    return finish(1);
  }
  const body = bodyResult.value;

  const cpu = os.cpus()[0]?.model ?? "unknown cpu";
  console.log(`\nconcurrent-upload memory bench — peak in-flight, isolated proxy process`);
  console.log(`  machine:        ${cpu} / ${process.platform}-${process.arch} / ${formatMiB(os.totalmem())} RAM`);
  console.log(`  node:           ${process.version}`);
  console.log(`  CONCURRENCY:    ${concurrency}`);
  console.log(`  BODY_MIB:       ${bodyMib} (maxBodyBytes = ${formatMiB(maxBodyBytes)})`);
  console.log(`  wire total:     ${formatMiB(concurrency * bodyBytes)}`);
  console.log(`  ceiling:        ${ceilingMiB.toFixed(1)} MiB peak RSS per in-flight request`);
  console.log(`  sampler:        ${SAMPLE_INTERVAL_MS} ms interval, running max, no forced GC`);
  console.log();

  if (bodyBytes > maxBodyBytes) {
    console.error(`BODY_MIB exceeds limits.maxBodyBytes — the relay will answer 413 and the run will fail.`);
    return finish(1);
  }

  const agent = new http.Agent({ keepAlive: false, maxSockets: concurrency + 4 });

  // Warm-up: one small request end to end, so pool/JIT/allocator warm-up is not
  // attributed to the measured window.
  const warmupBody = buildMessagesBody(512);
  if (!warmupBody.ok) {
    console.error(warmupBody.error);
    agent.destroy();
    return finish(1);
  }
  const warmup = postMessages(agent, proxyPort, warmupBody.value);
  const warmupArrived = await pollUntil(() => origin.arrivedCount >= 1, 30_000);
  origin.releaseAll();
  const warmupResult = await warmup;
  if (!warmupArrived || !warmupResult.ok || warmupResult.value !== 200) {
    console.error(`warm-up request failed: ${JSON.stringify(warmupResult)} (arrived=${String(warmupArrived)})`);
    agent.destroy();
    return finish(1);
  }

  // Arm the baseline in the child AFTER warm-up, then start the load.
  link.send({ kind: "arm" });
  const armed = await link.next(30_000);
  if (!armed.ok || armed.value.kind !== "armed") {
    console.error(!armed.ok ? armed.error : `unexpected message while arming: ${JSON.stringify(armed.value)}`);
    agent.destroy();
    return finish(1);
  }

  let settledEarly = 0;
  let released = false;
  const t0 = Date.now();
  const inFlight = Array.from({ length: concurrency }, () =>
    postMessages(agent, proxyPort, body).then((r) => {
      if (!released) settledEarly += 1;
      return r;
    }),
  );

  const allParked = await pollUntil(
    () => origin.arrivedCount >= concurrency || settledEarly > 0,
    PARK_ARRIVAL_TIMEOUT_MS,
  );
  const parkedAt = Date.now() - t0;

  // Hold the fully-parked window so the sampler observes it directly.
  await sleep(PARK_HOLD_MS);

  link.send({ kind: "report" });
  const report = await link.next(30_000);

  released = true;
  origin.releaseAll();
  const results = await Promise.all(inFlight);
  const elapsed = Date.now() - t0;
  agent.destroy();

  if (!report.ok || report.value.kind !== "report") {
    console.error(!report.ok ? report.error : `unexpected message instead of report: ${JSON.stringify(report.value)}`);
    return finish(1);
  }
  const { baseline, peak, samples } = report.value;

  const succeeded = results.filter((r) => r.ok && r.value === 200).length;
  const failed = results.length - succeeded;

  const rssDelta = peak.rss - baseline.rss;
  const heapDelta = peak.heapUsed - baseline.heapUsed;
  const externalDelta = peak.external - baseline.external;
  const rssPerRequest = rssDelta / concurrency;
  const heapPerRequest = heapDelta / concurrency;
  const amplification = rssDelta / (concurrency * bodyBytes);
  // Concurrency at which the proxy would cross 2 GiB of RSS growth if every request
  // were the configured maximum body — the number this bench exists to keep honest.
  const crossingAtMaxBody = (2048 * MIB) / (amplification * maxBodyBytes);

  console.log(`proxy child (isolated) — ${samples} samples over the measured window`);
  console.log(`  baseline: rss=${formatMiB(baseline.rss)} heap=${formatMiB(baseline.heapUsed)} external=${formatMiB(baseline.external)}`);
  console.log(`  PEAK:     rss=${formatMiB(peak.rss)} heap=${formatMiB(peak.heapUsed)} external=${formatMiB(peak.external)}`);
  console.log();
  console.log(`  delta rss:      ${formatDelta(rssDelta)}`);
  console.log(`  delta heap:     ${formatDelta(heapDelta)}`);
  console.log(`  delta external: ${formatDelta(externalDelta)}`);
  console.log();
  console.log(`  peak RSS  per in-flight request: ${formatMiB(rssPerRequest)}`);
  console.log(`  peak heap per in-flight request: ${formatMiB(heapPerRequest)}`);
  console.log(`  amplification over wire bytes:   ${amplification.toFixed(2)}x`);
  console.log(`  2 GiB RSS growth would be crossed at ~${crossingAtMaxBody.toFixed(0)} concurrent requests at maxBodyBytes (${formatMiB(maxBodyBytes)})`);
  console.log();
  console.log(`  all ${concurrency} parked after: ${parkedAt} ms`);
  console.log(`  elapsed (incl. release): ${elapsed} ms`);
  console.log(`  succeeded: ${succeeded} / ${concurrency}`);
  console.log(`  failed:    ${failed}`);

  const failures: string[] = [];
  if (!allParked) failures.push(`only ${origin.arrivedCount} of ${concurrency} uploads reached the origin`);
  if (settledEarly > 0) failures.push(`${settledEarly} request(s) were answered before release — expected all to park`);
  if (failed > 0) {
    const firstBad = results.find((r) => !r.ok || r.value !== 200);
    failures.push(`${failed} request(s) did not return 200 (first: ${JSON.stringify(firstBad)})`);
  }
  if (samples < 5) failures.push(`sampler produced only ${samples} samples — peak is not trustworthy`);
  if (rssPerRequest / MIB > ceilingMiB) {
    failures.push(
      `peak RSS per request ${formatMiB(rssPerRequest)} exceeds ceiling ${ceilingMiB.toFixed(1)} MiB`,
    );
  }

  console.log();
  if (failures.length === 0) {
    console.log(`PASS — ${concurrency} × ${formatMiB(bodyBytes)} parked in flight: ${formatMiB(rssPerRequest)}/request peak RSS, ceiling ${ceilingMiB.toFixed(1)} MiB`);
    return finish(0);
  }
  console.log(`FAIL — ${failures.join("; ")}`);
  return finish(1);
};

// ---------------------------------------------------------------------------
// Entry point: one file, two roles.
// ---------------------------------------------------------------------------

if (process.argv.includes(CHILD_ARG)) {
  runProxyChild().catch((e: unknown) => {
    console.error(e);
    process.exit(1);
  });
} else {
  runBench()
    .then((code) => {
      process.exit(code);
    })
    .catch((e: unknown) => {
      console.error(e);
      process.exit(1);
    });
}
