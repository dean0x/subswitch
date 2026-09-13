import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as http from "node:http";
import * as net from "node:net";
import { once } from "node:events";
import { createCodexRecorderServer } from "../../e2e/capture/codex-recorder.js";

const listen = async (server: http.Server): Promise<string> => {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return `http://127.0.0.1:${address.port}`;
};

const close = async (server: http.Server): Promise<void> => {
  server.close();
  await once(server, "close");
};

const post = (base: string, path: string, body: string): Promise<{ status: number; body: Buffer }> => new Promise((resolve, reject) => {
  const request = http.request(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json" } }, (response) => {
    const chunks: Buffer[] = [];
    response.on("data", (chunk: Buffer) => chunks.push(chunk));
    response.on("end", () => resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks) }));
  });
  request.on("error", reject);
  request.end(body);
});

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
  const chunks: Buffer[] = [];
  socket.on("data", (chunk: Buffer) => chunks.push(chunk));
  socket.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
  socket.on("error", reject);
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
});
