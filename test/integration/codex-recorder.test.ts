import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as http from "node:http";
import * as net from "node:net";
import { once } from "node:events";
import { createCodexRecorderServer } from "../../e2e/capture/codex-recorder.js";

/**
 * Deadline every helper in this file answers to.
 *
 * An unbounded helper turns a regression into the 30 s suite timeout, which names
 * neither the test that stalled nor the assertion that would have explained it. Each
 * helper below instead fails at this bound with a message naming what never finished.
 * Nothing in a passing run waits on it — the whole suite settles in well under a
 * second — so the bound is a failure path only and the suite stays deterministic.
 */
const HELPER_TIMEOUT_MS = 5_000;

const delay = (ms: number): Promise<void> => new Promise((resolve) => { setTimeout(resolve, ms); });

const withTimeout = async <T>(promise: Promise<T>, ms: number, message: string): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error(message)), ms); }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
};

const listen = async (server: http.Server): Promise<string> => {
  server.listen(0, "127.0.0.1");
  await withTimeout(once(server, "listening"), HELPER_TIMEOUT_MS, "server never reached the listening state");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return `http://127.0.0.1:${address.port}`;
};

const close = async (server: http.Server): Promise<void> => {
  server.close();
  await withTimeout(once(server, "close"), HELPER_TIMEOUT_MS, "server.close() never completed: a connection is still live");
};

/**
 * Close a server without waiting on connections the test deliberately left open.
 * `server.close()` alone waits for every live socket, which turns an assertion
 * failure in the streaming tests below into a suite hang instead of a red test.
 */
const closeHard = async (server: http.Server): Promise<void> => {
  server.closeAllConnections();
  server.close();
  await withTimeout(once(server, "close"), HELPER_TIMEOUT_MS, "server.close() never completed after closeAllConnections()");
};

/** Name what stalled when the deadline aborts a request, rather than surfacing a bare AbortError. */
const requestFailure = (err: Error, what: string): Error =>
  (err as NodeJS.ErrnoException).code === "ABORT_ERR"
    ? new Error(`${what} produced no complete response within ${HELPER_TIMEOUT_MS} ms`)
    : err;

/**
 * Options shared by the buffered request helpers: a JSON body with an explicit
 * content-length (so a body rides on any method, not just the ones Node frames by
 * default) and the deadline above.
 */
const jsonRequest = (body: string, method: string): http.RequestOptions => ({
  method,
  headers: { "content-type": "application/json", "content-length": String(Buffer.byteLength(body)) },
  signal: AbortSignal.timeout(HELPER_TIMEOUT_MS),
});

/** Send one buffered JSON request and read the whole response body. */
const send = (base: string, path: string, body: string, method: string): Promise<{ status: number; body: Buffer }> =>
  new Promise((resolve, reject) => {
    const request = http.request(`${base}${path}`, jsonRequest(body, method), (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("end", () => resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks) }));
    });
    request.on("error", (err: Error) => reject(requestFailure(err, `${method} ${path}`)));
    request.end(body);
  });

const post = (base: string, path: string, body: string): Promise<{ status: number; body: Buffer }> =>
  send(base, path, body, "POST");

/**
 * Same as `post`, but sampling `heapUsed` on every delivered chunk. Received
 * bytes land in Buffers (external memory), so the V8 heap figure reports what the
 * recorder *retains* rather than what it forwards.
 */
const postSampled = (base: string, path: string, body: string): Promise<{ status: number; body: Buffer; peakHeap: number }> =>
  new Promise((resolve, reject) => {
    const request = http.request(`${base}${path}`, jsonRequest(body, "POST"), (response) => {
      const chunks: Buffer[] = [];
      let peakHeap = 0;
      response.on("data", (chunk: Buffer) => {
        chunks.push(chunk);
        const used = process.memoryUsage().heapUsed;
        if (used > peakHeap) peakHeap = used;
      });
      response.on("end", () => resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks), peakHeap }));
    });
    request.on("error", (err: Error) => reject(requestFailure(err, `POST ${path} (heap-sampled)`)));
    request.end(body);
  });

/**
 * POST and hand back the live response before a single body byte is consumed.
 *
 * Only the wait for headers is bounded, and by a race rather than by an abort: the
 * caller deliberately stops reading for a while, so a deadline on the request itself
 * would cut the very stream this helper exists to hand over.
 */
const postStreaming = (base: string, path: string, body: string): Promise<http.IncomingMessage> =>
  withTimeout(
    new Promise<http.IncomingMessage>((resolve, reject) => {
      const request = http.request(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json" } }, resolve);
      request.on("error", reject);
      request.end(body);
    }),
    HELPER_TIMEOUT_MS,
    `POST ${path} produced no response headers within ${HELPER_TIMEOUT_MS} ms`,
  );

/**
 * Send a hand-written request line that `http.request` would refuse to encode,
 * so the recorder sees a raw, malformed request target.
 */
const rawPost = (base: string, target: string, body: string): Promise<string> => new Promise((resolve, reject) => {
  const port = Number(new URL(base).port);
  const socket = net.connect(port, "127.0.0.1", () => {
    socket.write(
      `POST ${target} HTTP/1.1\r\nHost: x\r\n` +
      `Content-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\n` +
      `Connection: close\r\n\r\n${body}`,
    );
  });
  // Idle bound: a recorder that answers nothing at all leaves this socket silent, and
  // a silent socket would otherwise be held until the suite timeout.
  socket.setTimeout(HELPER_TIMEOUT_MS, () => {
    socket.destroy();
    reject(new Error(`raw POST ${target} produced no complete response within ${HELPER_TIMEOUT_MS} ms`));
  });
  const chunks: Buffer[] = [];
  socket.on("data", (chunk: Buffer) => chunks.push(chunk));
  socket.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
  socket.on("error", reject);
});

/**
 * Build an SSE body of `count` event blocks.
 *
 * `completions` maps a 0-based event index to the `input_tokens` count that event
 * reports, so a fixture can place a `response.completed` on either side of the
 * printed-event cap; every other index is an ordinary delta.
 */
const sseWire = (count: number, completions: ReadonlyMap<number, number>): string => {
  const blocks: string[] = [];
  // Bounded by `count`, the literal each caller supplies.
  for (let index = 0; index < count; index++) {
    const inputTokens = completions.get(index);
    blocks.push(
      inputTokens === undefined
        ? 'data: {"type":"response.output_text.delta"}\n\n'
        : `data: ${JSON.stringify({ type: "response.completed", response: { usage: { input_tokens: inputTokens } } })}\n\n`,
    );
  }
  return blocks.join("");
};

/** Every `REQUEST #n` sequence number a transcript carries, in order, as strings. */
const seqNumbers = (transcript: readonly string[]): string[] =>
  transcript.flatMap((line) => {
    const match = /REQUEST #(\d+)\b/.exec(line);
    return match === null ? [] : [match[1] as string];
  });

describe("dev Codex recorder", () => {
  it("captures an eligible missing-header Responses stream, preserves bytes, and flushes EOF usage", async () => {
    const wire = [
      'data: {"type":"response.created"}\n\n',
      'data: {"type":"response.completed","response":{"usage":{"input_tokens":3,"output_tokens":2}}}',
    ].join("");
    const upstream = http.createServer((_req, res) => {
      res.writeHead(200); // deliberately no Content-Type
      res.write(wire.slice(0, 17));
      res.end(wire.slice(17));
    });
    const upstreamUrl = await listen(upstream);
    const output: string[] = [];
    const recorder = createCodexRecorderServer(upstreamUrl, (line) => output.push(line));
    const recorderUrl = await listen(recorder);
    try {
      const result = await post(recorderUrl, "/responses?trace=yes", JSON.stringify({ stream: true }));
      assert.equal(result.status, 200);
      assert.deepEqual(result.body, Buffer.from(wire));
      assert.ok(output.some((line) => line.includes("type=response.created")));
      assert.ok(output.some((line) => line.includes("type=response.completed")));
      assert.ok(output.some((line) => line.includes('TERMINAL USAGE: {"input_tokens":3,"output_tokens":2}')));
    } finally {
      await close(recorder);
      await close(upstream);
    }
  });

  it("prints 64-column separators, numbered event lines, and a total for a captured stream", async () => {
    const wire = [
      'data: {"type":"response.created"}\n\n',
      'data: {"type":"response.completed","response":{"usage":{"input_tokens":3,"output_tokens":2}}}\n\n',
    ].join("");
    const upstream = http.createServer((_req, res) => {
      res.writeHead(200); // deliberately no Content-Type
      res.end(wire);
    });
    const upstreamUrl = await listen(upstream);
    const output: string[] = [];
    const recorder = createCodexRecorderServer(upstreamUrl, (line) => output.push(line));
    const recorderUrl = await listen(recorder);
    try {
      const result = await post(recorderUrl, "/responses", JSON.stringify({ stream: true }));
      assert.deepEqual(result.body, Buffer.from(wire));
      assert.ok(
        output.includes("─".repeat(64)),
        `expected a separator rule of exactly 64 "─", got ${JSON.stringify(output.filter((line) => line.includes("─")))}`,
      );
      assert.deepEqual(output.filter((line) => line.startsWith("  [")), [
        "  [1] type=response.created",
        '  [2] type=response.completed  usage={"input_tokens":3,"output_tokens":2}',
      ]);
      assert.ok(output.includes("\n  SSE TOTAL: 2 events"), "SSE TOTAL line must report both events");
    } finally {
      await close(recorder);
      await close(upstream);
    }
  });

  it("does not inspect missing-header responses outside successful streamed POST /responses", async () => {
    const body = Buffer.from("not an SSE body");
    const upstream = http.createServer((_req, res) => { res.writeHead(200); res.end(body); });
    const upstreamUrl = await listen(upstream);
    const output: string[] = [];
    const recorder = createCodexRecorderServer(upstreamUrl, (line) => output.push(line));
    const recorderUrl = await listen(recorder);
    try {
      const result = await post(recorderUrl, "/other", JSON.stringify({ stream: true }));
      assert.deepEqual(result.body, body);
      assert.equal(output.some((line) => line === "SSE EVENTS:"), false);
    } finally {
      await close(recorder);
      await close(upstream);
    }
  });

  it("passes a headerless POST /responses through when the request body did not declare stream", async () => {
    const body = Buffer.from("not an SSE body");
    const upstream = http.createServer((_req, res) => { res.writeHead(200); res.end(body); });
    const upstreamUrl = await listen(upstream);
    const output: string[] = [];
    const recorder = createCodexRecorderServer(upstreamUrl, (line) => output.push(line));
    const recorderUrl = await listen(recorder);
    try {
      const result = await post(recorderUrl, "/responses", JSON.stringify({ stream: false }));
      assert.deepEqual(result.body, body);
      assert.equal(output.some((line) => line === "SSE EVENTS:"), false);
    } finally {
      await close(recorder);
      await close(upstream);
    }
  });

  it("passes a headerless streamed POST /responses through when upstream did not answer 2xx", async () => {
    const body = Buffer.from('data: {"type":"response.created"}\n\n');
    const upstream = http.createServer((_req, res) => { res.writeHead(429); res.end(body); });
    const upstreamUrl = await listen(upstream);
    const output: string[] = [];
    const recorder = createCodexRecorderServer(upstreamUrl, (line) => output.push(line));
    const recorderUrl = await listen(recorder);
    try {
      const result = await post(recorderUrl, "/responses", JSON.stringify({ stream: true }));
      assert.equal(result.status, 429);
      assert.deepEqual(result.body, body);
      assert.equal(output.some((line) => line === "SSE EVENTS:"), false);
    } finally {
      await close(recorder);
      await close(upstream);
    }
  });

  /**
   * PF-013 keeps the headerless-SSE rule pinned clause by clause, each clause with its
   * own negative test so deleting it cannot stay green behind a cheaper clause:
   *   path     → "does not inspect missing-header responses outside successful streamed POST /responses" (`/other`)
   *   request  → "passes a headerless POST /responses through when the request body did not declare stream"
   *   status   → "passes a headerless streamed POST /responses through when upstream did not answer 2xx"
   *   method   → this test
   */
  it("passes a headerless streamed /responses through when the method is not POST", async () => {
    // A genuine SSE body: were the method clause dropped, this request would clear every
    // remaining clause and print `[1] type=response.created`, which is what the
    // assertions below deny. A body on a GET is deliberate — `stream: true` has to reach
    // the recorder for the method to be the only clause left refusing.
    const wire = Buffer.from('data: {"type":"response.created"}\n\n');
    const upstream = http.createServer((_req, res) => { res.writeHead(200); res.end(wire); });
    const upstreamUrl = await listen(upstream);
    const output: string[] = [];
    const recorder = createCodexRecorderServer(upstreamUrl, (line) => output.push(line));
    const recorderUrl = await listen(recorder);
    try {
      const result = await send(recorderUrl, "/responses", JSON.stringify({ stream: true }), "GET");
      assert.equal(result.status, 200);
      assert.deepEqual(result.body, wire, "a pass-through body must reach the client verbatim (ADR-010)");
      assert.equal(output.some((line) => line === "SSE EVENTS:"), false, "a non-POST must take the pass-through arm");
      assert.deepEqual(
        output.filter((line) => line.startsWith("  [")),
        [],
        "no event line may be printed for a request the eligibility rule refuses",
      );
    } finally {
      await close(recorder);
      await close(upstream);
    }
  });

  it("survives a malformed request target that reaches the eligibility check", async () => {
    const body = Buffer.from("not an SSE body");
    const upstream = http.createServer((_req, res) => { res.writeHead(200); res.end(body); });
    const upstreamUrl = await listen(upstream);
    const output: string[] = [];
    const recorder = createCodexRecorderServer(upstreamUrl, (line) => output.push(line));
    const recorderUrl = await listen(recorder);
    try {
      // "//" is a protocol-relative target: `new URL("//", base)` throws
      // ERR_INVALID_URL. The eligibility check runs in the upstream response
      // callback, outside the promise handleRequest rejects, so an escaping
      // throw reaches uncaughtException and kills the recorder process.
      // The streamed body is required — it clears every cheaper clause so the
      // request target actually gets parsed.
      const raw = await rawPost(recorderUrl, "//", JSON.stringify({ stream: true }));
      assert.match(raw, /^HTTP\/1\.1 200/);

      // The recorder must still be serving after the malformed target.
      const after = await post(recorderUrl, "/responses", JSON.stringify({ stream: false }));
      assert.equal(after.status, 200);
      assert.deepEqual(after.body, body);
    } finally {
      await close(recorder);
      await close(upstream);
    }
  });

  it("continues to inspect explicit SSE even when the request is not a Responses stream", async () => {
    const wire = 'data: {"type":"response.completed","response":{"usage":{"total_tokens":1}}}\n\n';
    const upstream = http.createServer((_req, res) => { res.writeHead(201, { "content-type": "text/event-stream" }); res.end(wire); });
    const upstreamUrl = await listen(upstream);
    const output: string[] = [];
    const recorder = createCodexRecorderServer(upstreamUrl, (line) => output.push(line));
    const recorderUrl = await listen(recorder);
    try {
      const result = await post(recorderUrl, "/anything", JSON.stringify({ stream: false }));
      assert.deepEqual(result.body, Buffer.from(wire));
      assert.ok(output.some((line) => line === "SSE EVENTS:"));
    } finally {
      await close(recorder);
      await close(upstream);
    }
  });

  it("bounds the capture buffer when an eligible response carries no event boundary", async () => {
    // 16 MiB — four times MAX_SSE_BUFFER_CHARS — of single-newline lines, so the
    // accumulator never finds a blank line to drain on. Eligibility keys off the
    // REQUEST (PF-013), so this JSON-shaped-but-undelimited body reaches the SSE arm.
    const body = Buffer.from(("x".repeat(1023) + "\n").repeat(16 * 1024), "utf8");
    const warm = Buffer.from(":warm-up\n\n", "utf8");
    /** MAX_SSE_BUFFER_CHARS is 4 Mi chars; 3x that in bytes is a generous ceiling. */
    const heapGrowthLimitBytes = 12 * 1024 * 1024;
    const upstream = http.createServer((request, response) => {
      response.writeHead(200); // deliberately no Content-Type
      response.end(request.url?.includes("/warm/") === true ? warm : body);
    });
    const upstreamUrl = await listen(upstream);
    const output: string[] = [];
    const recorder = createCodexRecorderServer(upstreamUrl, (line) => output.push(line));
    const recorderUrl = await listen(recorder);
    try {
      // Warm the whole path once so the baseline is not measuring first-call lazy work.
      await post(recorderUrl, "/warm/responses", JSON.stringify({ stream: true }));
      const baseline = process.memoryUsage().heapUsed;

      const result = await postSampled(recorderUrl, "/responses", JSON.stringify({ stream: true }));

      assert.equal(result.status, 200);
      assert.equal(result.body.byteLength, body.byteLength);
      // Buffer.equals is deepEqual for Buffers without a 16 MiB diff on failure.
      assert.ok(result.body.equals(body), "capture may degrade, the forward may not (ADR-010)");

      const notices = output.filter((line) => line.includes("<cap:sse-residual>"));
      assert.equal(notices.length, 1, `expected exactly one residual cap notice, got ${JSON.stringify(notices)}`);

      const growth = result.peakHeap - baseline;
      assert.ok(
        growth < heapGrowthLimitBytes,
        `capture retained ${growth} bytes of heap while relaying a ${body.byteLength}-byte undelimited body (limit ${heapGrowthLimitBytes})`,
      );
    } finally {
      await closeHard(recorder);
      await closeHard(upstream);
    }
  });

  it("decodes a multi-byte character split across two upstream chunks", async () => {
    const wire = Buffer.from('data: {"type":"café.créated"}\n\n', "utf8");
    // Cut inside the SECOND "é" (0xC3 0xA9), between its two bytes.
    const cut = wire.indexOf(0xc3, wire.indexOf(0xc3) + 1) + 1;
    const upstream = http.createServer((_req, res) => {
      res.writeHead(200); // deliberately no Content-Type
      res.write(wire.subarray(0, cut));
      // A real gap, so the two halves cannot coalesce into one socket read.
      setTimeout(() => res.end(wire.subarray(cut)), 20);
    });
    const upstreamUrl = await listen(upstream);
    const output: string[] = [];
    const recorder = createCodexRecorderServer(upstreamUrl, (line) => output.push(line));
    const recorderUrl = await listen(recorder);
    try {
      const result = await post(recorderUrl, "/responses", JSON.stringify({ stream: true }));
      assert.deepEqual(result.body, wire);
      assert.ok(
        output.includes("  [1] type=café.créated"),
        `split multi-byte sequence must decode intact, got ${JSON.stringify(output.filter((line) => line.startsWith("  [")))}`,
      );
      assert.equal(output.some((line) => line.includes("�")), false, "no replacement characters may reach the transcript");
    } finally {
      await closeHard(recorder);
      await closeHard(upstream);
    }
  });

  it("pauses the upstream while the client is not reading, then delivers every byte", async () => {
    // One SSE comment block per chunk: real event boundaries (so the accumulator
    // drains and this test isolates backpressure) with nothing to print.
    const chunk = Buffer.from(":" + "a".repeat(64 * 1024) + "\n\n", "utf8");
    // 32 MiB — many times the loopback socket-buffer chain (measured ~4 MB), so a
    // paused pipeline provably cannot swallow the whole body.
    const totalChunks = 512;
    let handedToSocket = 0;
    const upstream = http.createServer((_req, res) => {
      res.writeHead(200); // deliberately no Content-Type
      const pump = (): void => {
        while (handedToSocket < totalChunks) {
          handedToSocket++;
          if (!res.write(chunk)) { res.once("drain", pump); return; }
        }
        res.end();
      };
      pump();
    });
    const upstreamUrl = await listen(upstream);
    const output: string[] = [];
    const recorder = createCodexRecorderServer(upstreamUrl, (line) => output.push(line));
    const recorderUrl = await listen(recorder);
    try {
      const response = await postStreaming(recorderUrl, "/responses", JSON.stringify({ stream: true }));
      response.pause();

      // Wait until the upstream either finishes or stops making progress. Bounded at
      // 20 samples so a regression fails the assertion rather than hanging the suite.
      let previous = -1;
      let stalledSamples = 0;
      for (let sample = 0; sample < 20 && handedToSocket < totalChunks && stalledSamples < 2; sample++) {
        await delay(100);
        stalledSamples = handedToSocket === previous ? stalledSamples + 1 : 0;
        previous = handedToSocket;
      }

      assert.ok(
        handedToSocket < totalChunks,
        `upstream streamed all ${totalChunks * chunk.byteLength} bytes into a client that never read one`,
      );

      const received = await withTimeout(new Promise<number>((resolve, reject) => {
        let bytes = 0;
        response.on("data", (part: Buffer) => { bytes += part.byteLength; });
        response.on("end", () => resolve(bytes));
        response.on("error", reject);
        response.resume();
      }), 10_000, "resumed client never received the full body");

      assert.equal(received, totalChunks * chunk.byteLength, "every paused byte must still arrive after the drain");
    } finally {
      await closeHard(recorder);
      await closeHard(upstream);
    }
  });

  it("terminates the client response when the upstream dies mid-stream", async () => {
    const upstream = http.createServer((_req, res) => {
      res.writeHead(200); // deliberately no Content-Type
      res.write('data: {"type":"response.created"}\n\n');
      setTimeout(() => res.socket?.destroy(), 20);
    });
    const upstreamUrl = await listen(upstream);
    const output: string[] = [];
    const recorder = createCodexRecorderServer(upstreamUrl, (line) => output.push(line));
    const recorderUrl = await listen(recorder);
    let request: http.ClientRequest | undefined;
    try {
      const outcome = await new Promise<string>((resolve, reject) => {
        // PF-022: with teardown gated on the reply latch the client waits forever.
        const timer = setTimeout(() => reject(new Error("client saw neither end, abort, nor error within 1000 ms")), 1000);
        const settle = (what: string): void => { clearTimeout(timer); resolve(what); };
        request = http.request(`${recorderUrl}/responses`, { method: "POST", headers: { "content-type": "application/json" } }, (response) => {
          response.on("data", () => undefined);
          response.on("aborted", () => settle("aborted"));
          response.on("error", (err: Error) => settle(`error:${err.message}`));
          response.on("end", () => settle("end"));
        });
        request.on("error", (err: Error) => settle(`request-error:${err.message}`));
        request.end(JSON.stringify({ stream: true }));
      });

      assert.notEqual(outcome, "end", "a truncated upstream stream must not be presented to the client as a clean end");
      assert.ok(output.some((line) => line.includes("SSE UPSTREAM ERROR")), "the mid-stream failure must be recorded");
    } finally {
      request?.destroy();
      await closeHard(recorder);
      await closeHard(upstream);
    }
  });

  it("tears down the upstream when the client disconnects mid-stream", async () => {
    let markUpstreamClosed: () => void = () => undefined;
    const upstreamClosed = new Promise<void>((resolve) => { markUpstreamClosed = resolve; });
    const upstream = http.createServer((_req, res) => {
      res.writeHead(200); // deliberately no Content-Type
      let ticks = 0;
      const timer = setInterval(() => {
        if (ticks++ >= 40) { clearInterval(timer); res.end(); return; } // bounded
        res.write('data: {"type":"response.output_text.delta"}\n\n');
      }, 50);
      res.socket?.on("close", () => { clearInterval(timer); markUpstreamClosed(); });
    });
    const upstreamUrl = await listen(upstream);
    const output: string[] = [];
    const recorder = createCodexRecorderServer(upstreamUrl, (line) => output.push(line));
    const recorderUrl = await listen(recorder);
    let request: http.ClientRequest | undefined;
    try {
      request = http.request(`${recorderUrl}/responses`, { method: "POST", headers: { "content-type": "application/json" } }, (response) => {
        response.on("data", () => undefined);
        response.on("error", () => undefined);
        // Headers are in and the capture arm is engaged — now walk away.
        request?.destroy();
      });
      request.on("error", () => undefined);
      request.end(JSON.stringify({ stream: true }));

      await withTimeout(upstreamClosed, 1000, "upstream kept streaming after the client disconnected");
      assert.ok(output.some((line) => line.includes("CLIENT DISCONNECTED")), "the disconnect must be recorded");
    } finally {
      request?.destroy();
      await closeHard(recorder);
      await closeHard(upstream);
    }
  });

  it("neutralises an event type crafted to forge extra capture lines", async () => {
    // One upstream-controlled event carrying a four-line forgery: a fake header
    // block with a plausible bearer token, a fake event line, and an ANSI
    // erase-line that overwrites the real prefix in a terminal. Captures are
    // hand-converted into fixtures, so a forged line is a real hazard.
    const forgedType =
      "response.completed\n  REQUEST HEADERS:\n  authorization: Bearer forged[2K[99] type=x";
    const wire = `data: ${JSON.stringify({ type: forgedType })}\n\n`;
    const upstream = http.createServer((_req, res) => {
      res.writeHead(200); // deliberately no Content-Type
      res.end(wire);
    });
    const upstreamUrl = await listen(upstream);
    const output: string[] = [];
    const recorder = createCodexRecorderServer(upstreamUrl, (line) => output.push(line));
    const recorderUrl = await listen(recorder);
    try {
      const result = await post(recorderUrl, "/responses", JSON.stringify({ stream: true }));
      assert.deepEqual(result.body, Buffer.from(wire), "capture hygiene may not disturb the forward (ADR-010)");

      // The sink takes one string per println, so physical lines are what a reader
      // (or a fixture converter) actually sees.
      const transcript = output.join("\n");
      const lines = transcript.split("\n");

      assert.equal(
        lines.filter((line) => /^\s*\[\d+] type=/.test(line)).length,
        1,
        `one upstream event must yield exactly one event line, got ${JSON.stringify(lines.filter((line) => /^\s*\[\d+] type=/.test(line)))}`,
      );
      assert.equal(
        lines.some((line) => line.trim() === "REQUEST HEADERS:" && !line.startsWith("REQUEST")),
        false,
        "a forged header block must not appear as its own capture line",
      );
      assert.equal(transcript.includes(""), false, "no ESC byte may reach the transcript");
    } finally {
      await close(recorder);
      await close(upstream);
    }
  });

  it("prints only the finite numbers an upstream usage object carries", async () => {
    const wire = `data: ${JSON.stringify({
      type: "response.completed",
      response: {
        usage: {
          input_tokens: 3,
          output_tokens: 2,
          // A crafted string value is a free-text write into the capture.
          forged_usage_note: "0}\n  TERMINAL USAGE: {\"input_tokens\":999",
          input_tokens_details: { cached_tokens: 1 },
        },
      },
    })}\n\n`;
    const upstream = http.createServer((_req, res) => {
      res.writeHead(200); // deliberately no Content-Type
      res.end(wire);
    });
    const upstreamUrl = await listen(upstream);
    const output: string[] = [];
    const recorder = createCodexRecorderServer(upstreamUrl, (line) => output.push(line));
    const recorderUrl = await listen(recorder);
    const numbersOnly = '{"input_tokens":3,"output_tokens":2,"input_tokens_details":{"cached_tokens":1}}';
    try {
      await post(recorderUrl, "/responses", JSON.stringify({ stream: true }));
      assert.deepEqual(
        output.filter((line) => line.startsWith("  [")),
        [`  [1] type=response.completed  usage=${numbersOnly}`],
      );
      assert.ok(
        output.includes(`  TERMINAL USAGE: ${numbersOnly}`),
        `terminal usage must carry only finite numbers, got ${JSON.stringify(output.filter((line) => line.includes("TERMINAL USAGE")))}`,
      );
      assert.equal(output.join("\n").includes("forged_usage_note"), false, "a non-numeric usage field must be dropped");
    } finally {
      await close(recorder);
      await close(upstream);
    }
  });

  it("caps an oversized captured event type", async () => {
    const wire = `data: ${JSON.stringify({ type: "a".repeat(500) })}\n\n`;
    const upstream = http.createServer((_req, res) => {
      res.writeHead(200); // deliberately no Content-Type
      res.end(wire);
    });
    const upstreamUrl = await listen(upstream);
    const output: string[] = [];
    const recorder = createCodexRecorderServer(upstreamUrl, (line) => output.push(line));
    const recorderUrl = await listen(recorder);
    try {
      await post(recorderUrl, "/responses", JSON.stringify({ stream: true }));
      assert.deepEqual(
        output.filter((line) => line.startsWith("  [")),
        [`  [1] type=${"a".repeat(128)}…`],
      );
    } finally {
      await close(recorder);
      await close(upstream);
    }
  });

  /**
   * The printed-event cap and the terminal-usage latch are separate controls, so the
   * numbers here are separate too: importing `MAX_SSE_EVENTS` would make the test agree
   * with whatever the code currently says instead of pinning what it must say (PF-011).
   * 205 streamed events against 200 expected printed lines is the control.
   */
  it("prints only the first 200 event lines and keeps the earlier terminal usage", async () => {
    const eventCount = 205;
    const printedCap = 200;
    // A completion on each side of the cap, carrying different counts: the first one
    // wins the TERMINAL USAGE line and the second must not produce a second line.
    const wire = sseWire(eventCount, new Map([[0, 11], [eventCount - 1, 22]]));
    const upstream = http.createServer((_req, res) => {
      res.writeHead(200); // deliberately no Content-Type
      res.end(wire);
    });
    const upstreamUrl = await listen(upstream);
    const output: string[] = [];
    const recorder = createCodexRecorderServer(upstreamUrl, (line) => output.push(line));
    const recorderUrl = await listen(recorder);
    try {
      const result = await post(recorderUrl, "/responses", JSON.stringify({ stream: true }));
      assert.equal(result.status, 200);
      // Buffer.equals is deepEqual for Buffers without dumping the whole stream on failure.
      assert.ok(result.body.equals(Buffer.from(wire)), "the print cap may bound capture, never the forward (ADR-010)");

      const eventLines = output.filter((line) => line.startsWith("  ["));
      assert.equal(
        eventLines.length,
        printedCap,
        `expected exactly ${printedCap} printed event lines from ${eventCount} events, got ${eventLines.length}`,
      );
      assert.equal(eventLines[0], '  [1] type=response.completed  usage={"input_tokens":11}');
      assert.equal(eventLines[printedCap - 1], `  [${printedCap}] type=response.output_text.delta`);

      assert.deepEqual(
        output.filter((line) => line.includes("(cap:")),
        ["  ... (cap: first 200 events printed; counting only)"],
        "the cap notice must be printed exactly once, on the event that crosses it",
      );
      assert.deepEqual(
        output.filter((line) => line.includes("TERMINAL USAGE:")),
        ['  TERMINAL USAGE: {"input_tokens":11}'],
        "terminal usage is latched: the first completion wins and no later one reopens it",
      );
      assert.ok(
        output.includes(`\n  SSE TOTAL: ${eventCount} events`),
        `the counter must keep running past the print cap, got ${JSON.stringify(output.filter((line) => line.includes("SSE TOTAL")))}`,
      );
    } finally {
      await closeHard(recorder);
      await closeHard(upstream);
    }
  });

  it("records a terminal usage that arrives after the event cap", async () => {
    const eventCount = 205;
    const printedCap = 200;
    // The only completion sits past the cap. Usage is terminal accounting, not event
    // detail, so the cap that silences the event line must not silence the usage.
    const wire = sseWire(eventCount, new Map([[eventCount - 1, 7]]));
    const upstream = http.createServer((_req, res) => {
      res.writeHead(200); // deliberately no Content-Type
      res.end(wire);
    });
    const upstreamUrl = await listen(upstream);
    const output: string[] = [];
    const recorder = createCodexRecorderServer(upstreamUrl, (line) => output.push(line));
    const recorderUrl = await listen(recorder);
    try {
      const result = await post(recorderUrl, "/responses", JSON.stringify({ stream: true }));
      assert.ok(result.body.equals(Buffer.from(wire)), "the print cap may bound capture, never the forward (ADR-010)");

      assert.deepEqual(
        output.filter((line) => line.includes("TERMINAL USAGE:")),
        ['  TERMINAL USAGE: {"input_tokens":7}'],
        "a completion past the print cap must still report its usage",
      );
      assert.equal(output.filter((line) => line.startsWith("  [")).length, printedCap);
      assert.equal(
        output.some((line) => line.includes("type=response.completed")),
        false,
        "the completed event itself fell past the print cap, so only its usage survives",
      );
    } finally {
      await closeHard(recorder);
      await closeHard(upstream);
    }
  });

  it("numbers requests per recorder rather than per process", async () => {
    const upstream = http.createServer((_req, res) => { res.writeHead(200); res.end("ok"); });
    const upstreamUrl = await listen(upstream);
    const first: string[] = [];
    const second: string[] = [];
    const recorderA = createCodexRecorderServer(upstreamUrl, (line) => first.push(line));
    const recorderB = createCodexRecorderServer(upstreamUrl, (line) => second.push(line));
    const urlA = await listen(recorderA);
    const urlB = await listen(recorderB);
    try {
      await post(urlA, "/one", "{}");
      await post(urlB, "/one", "{}");
      // Exact sequence numbers: `includes("REQUEST #1")` also matches "REQUEST #15",
      // which a module-global counter would happily produce.
      assert.deepEqual(seqNumbers(first), ["1"], "first recorder must label its only request #1");
      assert.deepEqual(seqNumbers(second), ["1"], "second recorder must label its only request #1");
    } finally {
      await close(recorderA);
      await close(recorderB);
      await close(upstream);
    }
  });
});

/**
 * ADR-009: the recorder forwards `authorization`, `chatgpt-account-id` and `cookie`
 * verbatim, so the upstream URL is a credential-bearing URL and must be vetted before
 * anything can listen. PF-026: the loopback arm is the project's exact-form predicate,
 * never a prefix test.
 */
describe("dev Codex recorder upstream vetting", () => {
  it("refuses a cleartext upstream on a non-loopback host", () => {
    assert.throws(() => createCodexRecorderServer("http://evil.test"), /evil\.test/);
  });

  it("refuses a host that merely begins with the loopback literal", () => {
    assert.throws(() => createCodexRecorderServer("http://127.0.0.1.evil.test:4142"), /127\.0\.0\.1\.evil\.test/);
  });

  it("refuses an upstream that is not a URL at all", () => {
    assert.throws(() => createCodexRecorderServer("not-a-url"), /not-a-url/);
  });

  it("refuses an https upstream on a host other than the Codex default", () => {
    assert.throws(() => createCodexRecorderServer("https://evil.test"), /evil\.test/);
  });

  it("accepts loopback upstreams and the default Codex host", () => {
    assert.doesNotThrow(() => createCodexRecorderServer("http://127.0.0.1:4142"));
    assert.doesNotThrow(() => createCodexRecorderServer("http://localhost:4142"));
    assert.doesNotThrow(() => createCodexRecorderServer("https://chatgpt.com/backend-api/codex"));
  });

  it("accepts a foreign https upstream only under the explicit opt-in", () => {
    assert.doesNotThrow(() =>
      createCodexRecorderServer("https://replay.example", undefined, { allowInsecureUpstream: true }));
  });
});
