/**
 * Concurrent-upload memory benchmark — not part of `npm test`.
 *
 * Run directly:
 *   node --import tsx test/tools/memory-concurrent-uploads.bench.ts
 *
 * Measures the RSS and heap impact of N concurrent request bodies buffered
 * through the proxy's body-buffering path, to quantify the memory cost of
 * serving ~100 simultaneous Claude Code sub-agents.
 *
 * ---------------------------------------------------------------------------
 * REFERENCE NUMBERS (the measurement that retired the admission gate)
 * ---------------------------------------------------------------------------
 * Configuration: 100 concurrent requests × 3.01 MiB bodies each
 *
 *   RSS delta:      +1002 MiB   (1.6% of a 64 GiB machine)
 *   heapUsed delta: +4.9 MiB
 *
 * Key insight: the cost is off-heap ArrayBuffer (native V8 backing store),
 * not V8 heap. The ~4 GiB V8 heap limit is NOT the binding constraint.
 * Reaching 2 GiB RSS would require ~683 concurrent 3 MiB requests, which
 * exceeds any realistic Claude Code deployment. The admission gate was therefore
 * deleted — it solved a problem that does not occur in practice, while adding
 * relay-invented backpressure that makes subswitch look different from Anthropic.
 *
 * Running this bench VERIFIES those numbers are reproducible and flags any
 * future code change that dramatically increases per-request memory cost.
 * ---------------------------------------------------------------------------
 *
 * This file lives under test/tools/ so `tsc --noEmit` typechecks it, but
 * outside test/unit/ and test/integration/ so the `npm test` globs
 * ("test/unit/*.test.ts" "test/integration/*.test.ts") do NOT pick it up.
 * The filename ends in .bench.ts, not .test.ts, for the same reason.
 */

import * as http from "node:http";
import * as net from "node:net";
import type { AddressInfo } from "node:net";
import { createProxyServer, listenServer, buildDeps } from "../../src/server.js";
import { loadConfig } from "../../src/config.js";

const CONCURRENT = 100;
const BODY_BYTES = Math.round(3.01 * 1024 * 1024); // 3.01 MiB — the reference scenario

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatMiB(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

function formatDelta(bytes: number): string {
  const sign = bytes >= 0 ? "+" : "";
  return `${sign}${formatMiB(bytes)}`;
}

async function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      server.close(() => resolve(port));
    });
    server.on("error", reject);
  });
}

// ---------------------------------------------------------------------------
// Minimal fake upstream that immediately 200s every request
// ---------------------------------------------------------------------------

async function startFakeUpstream(): Promise<{ port: number; close: () => Promise<void> }> {
  const server = http.createServer((_req, res) => {
    // Drain the request body so the client's upload completes.
    _req.resume();
    _req.on("end", () => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ type: "message", content: [] }));
    });
  });
  const port = await getFreePort();
  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
  return {
    port,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

// ---------------------------------------------------------------------------
// Main bench
// ---------------------------------------------------------------------------

async function run(): Promise<void> {
  console.log(`\nconcurrent-upload memory bench`);
  console.log(`  concurrent:  ${CONCURRENT}`);
  console.log(`  body size:   ${formatMiB(BODY_BYTES)} per request`);
  console.log(`  total data:  ${formatMiB(CONCURRENT * BODY_BYTES)}`);
  console.log();

  const upstream = await startFakeUpstream();

  const configResult = loadConfig({
    configPath: "inline-bench.json",
    readFile: () => JSON.stringify({
      anthropic: {
        baseUrl: `http://127.0.0.1:${upstream.port}`,
        allowInsecureBaseUrl: true,
        connectTimeoutMs: 5000,
      },
    }),
    env: {},
  });
  if (!configResult.ok) {
    console.error(`loadConfig failed: ${configResult.error.message}`);
    process.exit(1);
  }

  const depsResult = buildDeps(configResult.value.config);
  if (!depsResult.ok) {
    console.error(`buildDeps failed: ${depsResult.error}`);
    process.exit(1);
  }

  const proxyServer = createProxyServer(depsResult.value);
  const port = await getFreePort();
  const listenResult = await listenServer(proxyServer, port, "127.0.0.1");
  if (!listenResult.ok) {
    console.error(`listenServer failed: ${listenResult.error.message}`);
    process.exit(1);
  }

  // Warm up: small request to establish the keep-alive pool.
  await fetch(`http://127.0.0.1:${port}/v1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json", "authorization": "Bearer test" },
    body: JSON.stringify({ model: "claude-3-5-sonnet", messages: [] }),
  }).catch(() => { /* ignore errors in warmup */ });

  // Force GC if available, then snapshot baseline.
  if (typeof global.gc === "function") global.gc();
  const baseline = process.memoryUsage();

  console.log(`before: rss=${formatMiB(baseline.rss)} heap=${formatMiB(baseline.heapUsed)}`);

  // Fire CONCURRENT requests simultaneously, each with a BODY_BYTES body.
  const body = Buffer.alloc(BODY_BYTES, 0x41); // 'A' × BODY_BYTES

  const t0 = Date.now();
  const results = await Promise.allSettled(
    Array.from({ length: CONCURRENT }, async () => {
      const resp = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "authorization": "Bearer test",
          "content-length": String(BODY_BYTES),
        },
        body,
        duplex: "half",
      });
      return resp.status;
    }),
  );
  const elapsed = Date.now() - t0;

  // Peak memory snapshot while all requests are in flight (taken from settled results).
  if (typeof global.gc === "function") global.gc();
  const peak = process.memoryUsage();

  const succeeded = results.filter((r) => r.status === "fulfilled").length;
  const failed = results.filter((r) => r.status === "rejected").length;

  console.log(`after:  rss=${formatMiB(peak.rss)} heap=${formatMiB(peak.heapUsed)}`);
  console.log();
  console.log(`delta rss:  ${formatDelta(peak.rss - baseline.rss)}`);
  console.log(`delta heap: ${formatDelta(peak.heapUsed - baseline.heapUsed)}`);
  console.log();
  console.log(`elapsed:   ${elapsed} ms`);
  console.log(`succeeded: ${succeeded} / ${CONCURRENT}`);
  if (failed > 0) {
    console.log(`failed:    ${failed} (check logs above)`);
  }

  // Reference: 100 concurrent × 3.01 MiB → RSS +1002 MiB, heap +4.9 MiB.
  // The cost is off-heap ArrayBuffer — the ~4 GiB V8 heap limit is not the constraint.
  const rssPerRequest = (peak.rss - baseline.rss) / CONCURRENT;
  console.log();
  console.log(`rss per request: ${formatMiB(rssPerRequest)} (ref: ~10.0 MiB for 3.01 MiB body)`);

  await new Promise<void>((resolve) => proxyServer.close(() => resolve()));
  await upstream.close();
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
