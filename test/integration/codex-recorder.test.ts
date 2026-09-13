import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as http from "node:http";
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
