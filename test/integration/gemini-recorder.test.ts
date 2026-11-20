import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import * as http from "node:http";
import { it } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { createGeminiRecorderServer } from "../../e2e/capture/gemini-recorder.js";

const TIMEOUT_MS = 5_000;
const OPTIONS = { timeout: TIMEOUT_MS + 1_000 };
const LOOPBACK = "127.0.0.1";

const listen = async (server: http.Server): Promise<string> => {
  server.listen(0, LOOPBACK);
  await once(server, "listening", { signal: AbortSignal.timeout(TIMEOUT_MS) });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return `http://${LOOPBACK}:${address.port}`;
};

const close = async (server: http.Server): Promise<void> => {
  const closed = once(server, "close", { signal: AbortSignal.timeout(TIMEOUT_MS) });
  server.close();
  server.closeAllConnections();
  await closed;
};

const withRecorder = async (
  respond: http.RequestListener,
  run: (base: string, output: readonly string[]) => Promise<void>,
): Promise<void> => {
  const upstream = http.createServer(respond);
  try {
    const upstreamUrl = await listen(upstream);
    const output: string[] = [];
    const recorder = createGeminiRecorderServer({ upstream: upstreamUrl, output: (line) => output.push(line) });
    try {
      await run(await listen(recorder), output);
    } finally {
      await close(recorder);
    }
  } finally {
    await close(upstream);
  }
};

const send = (
  base: string,
  options: http.RequestOptions,
  body?: Buffer,
  onFirstChunk?: () => void,
): Promise<{ status: number | undefined; headers: http.IncomingHttpHeaders; body: Buffer }> =>
  new Promise((resolve, reject) => {
    const req = http.request(base, { ...options, signal: AbortSignal.timeout(TIMEOUT_MS) }, (res) => {
      const chunks: Buffer[] = [];
      res.once("error", reject);
      if (onFirstChunk !== undefined) res.once("data", onFirstChunk);
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.once("error", reject);
    req.end(body);
  });

/** A decoded view can print after the relay ends; wait a bounded time for its line. */
const waitForLine = async (output: readonly string[], pattern: RegExp): Promise<void> => {
  for (let tries = 0; tries < TIMEOUT_MS / 10 && !output.some((line) => pattern.test(line)); tries++) await delay(10);
};

it("relays the Gemini request and split SSE bytes but prints only permitted values", OPTIONS, async () => {
  const token = "fake-bearer-719a";
  const project = "fake-project-38db";
  const prompt = "fake private prompt 7a59";
  const arg = "fake tool input 12c3";
  const signature = "fake-signature-d19e";
  const email = "fake-91e7@example.invalid";
  const traceId = "fake-trace-6bea";
  const requestId = "fake-query-and-request-50c2";
  const upstreamHeader = "fake-response-header-800e";
  const requestBody = Buffer.from(JSON.stringify({
    project,
    model: "gemini-fabricated",
    request: {
      contents: [{ role: "user", parts: [
        { text: prompt },
        { functionCall: { name: "lookup", args: { model: arg }, id: "fake-call-id-113" } },
        { thought: true, thoughtSignature: signature },
      ] }],
      systemInstruction: { parts: [{ text: "fake system instruction" }] },
      tools: [{ functionDeclarations: [{ name: "lookup" }] }],
    },
    userEmail: email,
    requestId,
  }, null, 2));
  const wire = Buffer.from([
    `data: ${JSON.stringify({ response: { modelVersion: "gemini-bâtch", candidates: [], usageMetadata: { totalTokenCount: 4242 } }, traceId })}\r\n\r\n`,
    ': fake SSE comment\nother: fake SSE field\n\n',
    'data: {"response":{"candidates":[{"content":{"parts":[{"text":"fake reply"}]}}]}}\n\n',
    `data: ${JSON.stringify({ response: { candidates: [{ finishReason: "STOP\n\u001b\u0085 FORGED" }] } })}`,
  ].join(""));
  const split = wire.indexOf(Buffer.from("â")) + 1;
  assert.ok(split > 1);
  const path = `/v1internal:streamGenerateContent?alt=sse&%78=${requestId}&x=again`;
  let received: { method?: string | undefined; path?: string | undefined; headers: http.IncomingHttpHeaders; body: Buffer } | undefined;
  let sendRest: (() => void) | undefined;
  await withRecorder((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      received = { method: req.method, path: req.url, headers: req.headers, body: Buffer.concat(chunks) };
      res.writeHead(201, {
        "content-type": "text/event-stream; charset=utf-8",
        "x-response-test": upstreamHeader,
        "connection": "x-response-hop",
        "x-response-hop": "fake response hop",
      });
      sendRest = () => res.end(wire.subarray(split));
      res.write(wire.subarray(0, split));
    });
  }, async (base, output) => {
    const result = await send(base, {
      path, method: "PATCH", headers: {
        "authorization": `Bearer ${token}`,
        "content-type": "application/json",
        "content-length": requestBody.length,
        "user-agent": "Fabricated AGY/0.1 (test; exact spacing)",
        "x-goog-api-client": "fake-sdk/1.2 trace/3.4",
        "connection": "x-request-hop",
        "x-request-hop": "fake request hop",
      },
    }, requestBody, () => sendRest?.());
    assert.equal(received?.method, "PATCH");
    assert.equal(received.path, path);
    assert.deepEqual(received.body, requestBody);
    assert.equal(received.headers.authorization, `Bearer ${token}`);
    assert.equal(received.headers["x-request-hop"], undefined);
    assert.equal(result.status, 201);
    assert.equal(result.headers["x-response-test"], upstreamHeader);
    assert.equal(result.headers["x-response-hop"], undefined);
    assert.deepEqual(result.body, wire);
    const transcript = output.join("\n");
    for (const literal of [token, project, prompt, arg, signature, email, traceId, requestId, upstreamHeader,
      "fake-call-id-113", "fake system instruction", "fake reply", "fake SSE comment", "fake SSE field",
      "fake request hop", "fake response hop"]) {
      assert.ok(!transcript.includes(literal), `Transcript disclosed a fabricated value: ${literal}`);
    }
    assert.ok(output.every((line) => !/[\n\r\u001b\u0085\u{2028}]/u.test(line) && line.startsWith("#1 ")));
    for (const shape of [
      '#1 REQUEST PATCH /v1internal:streamGenerateContent?alt="sse"&x&x',
      'authorization: <len:23,sha8:',
      'user-agent: Fabricated AGY/0.1 (test; exact spacing)',
      'x-goog-api-client: fake-sdk/1.2 trace/3.4',
      '$.project=<len:',
      '$.model=string(len=17,value="gemini-fabricated")',
      '$.request.contents[0].parts[0].text=string(len=24)',
      '$.request.contents[0].parts[1].functionCall=object',
      '$.request.contents[0].parts[1].functionCall.args.model=string(len=20)',
      '$.request.contents[0].parts[2].thoughtSignature=<len:',
      '$.request.systemInstruction=object',
      '$.request.tools=array(len=1)',
      '#1 RESPONSE status=201',
      '#1 SSE event=1 bytes=',
      'value="gemini-bâtch"',
      '$.response.usageMetadata.totalTokenCount=number(4242)',
      '#1 SSE event=3 bytes=',
      'value="STOPFORGED"',
      '#1 SSE kind=comment',
      '#1 SSE kind=other',
      '#1 SSE TOTAL events=3',
      `#1 TOTAL status=201 requestBytes=${requestBody.length} responseBytes=${wire.length}`,
    ]) assert.ok(transcript.includes(shape), `Missing transcript shape: ${shape}`);
  });
});

it("prints JSON errors and direct tier ids, preserves the body, and does not follow redirects", OPTIONS, async () => {
  const body = Buffer.from(JSON.stringify({
    error: { status: "RESOURCE_EXHAUSTED", code: 429, details: [{ "@type": "type.example/Test", reason: "TEST_QUOTA" }] },
    currentTier: { id: "g1-pro-tier", nested: { id: "fake-nested-id" } },
    allowedTiers: [{ id: "g1-basic-tier" }],
  }));
  await withRecorder((req, res) => {
    if (req.url === "/redirect") {
      res.writeHead(307, { location: "/v1internal:loadCodeAssist" }).end();
    } else {
      res.writeHead(429, { "content-type": "application/json", "content-length": body.length }).end(body);
    }
  }, async (base, output) => {
    const response = await send(base, { path: "/v1internal:loadCodeAssist" });
    assert.equal(response.status, 429);
    assert.equal(response.headers["content-length"], String(body.length));
    assert.deepEqual(response.body, body);
    const transcript = output.join("\n");
    for (const shape of [
      '$.error.status=string(len=18,value="RESOURCE_EXHAUSTED")', '$.error.code=number(429)',
      '$.error.details[0]["@type"]=string(len=17,value="type.example/Test")',
      '$.error.details[0].reason=string(len=10,value="TEST_QUOTA")',
      '$.currentTier.id=string(len=11,value="g1-pro-tier")',
      '$.allowedTiers[0].id=string(len=13,value="g1-basic-tier")',
    ]) assert.ok(transcript.includes(shape), `Missing transcript shape: ${shape}`);
    assert.ok(!transcript.includes("fake-nested-id"));
    const redirect = await send(base, { path: "/redirect" });
    assert.equal(redirect.status, 307);
    assert.equal(redirect.headers.location, "/v1internal:loadCodeAssist");
    assert.ok(output.includes("#2 REQUEST GET /redirect"));
  });
});

it("returns a fixed 502 when the upstream disconnects before its reply", OPTIONS, async () => {
  await withRecorder((req) => req.destroy(), async (base, output) => {
    const response = await send(base, { path: "/v1internal:fetchAvailableModels" });
    assert.equal(response.status, 502);
    assert.equal(response.body.toString(), "upstream connection error");
    assert.match(output.join("\n"), /#1 TOTAL status=502 requestBytes=0 responseBytes=\d+/u);
  });
});

it("tears down the upstream when the client disconnects mid-stream", OPTIONS, async () => {
  let markUpstreamClosed: () => void = () => undefined;
  const upstreamClosed = new Promise<boolean>((resolve) => { markUpstreamClosed = () => resolve(true); });
  await withRecorder((_req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    let ticks = 0;
    const timer = setInterval(() => {
      // Bounded: the stream ends by itself after about 2 s, later than the wait below.
      if (ticks++ >= 40) {
        clearInterval(timer);
        res.end();
        return;
      }
      res.write('data: {"response":{}}\n\n');
    }, 50);
    res.socket?.once("close", () => {
      clearInterval(timer);
      markUpstreamClosed();
    });
  }, async (base, output) => {
    const request = http.request(`${base}/v1internal:streamGenerateContent?alt=sse`, (response) => {
      response.on("error", () => undefined);
      // Headers and a first body chunk are in, so the relay is mid-stream.
      response.once("data", () => request.destroy());
    });
    request.on("error", () => undefined);
    request.end();
    const closed = await Promise.race([upstreamClosed, delay(1_000, false)]);
    assert.ok(closed, "upstream kept streaming after the client disconnected");
    await waitForLine(output, /kind=aborted/u);
    assert.ok(output.some((line) => /^#1 TOTAL status=200 requestBytes=0 responseBytes=\d+ kind=aborted$/u.test(line)),
      output.join("\n"));
  });
});

it("bounds SSE lines and skeleton arrays without dropping relay bytes", OPTIONS, async () => {
  const large = `data: ${"x".repeat(4 * 1024 * 1024 + 1)}\n\n`;
  const data = JSON.stringify({ candidates: Array.from({ length: 50 }, () => ({})), model: "m".repeat(256) });
  const body = Buffer.from(`${large}data: ${data}\n\ndata: fake malformed payload\n`);
  await withRecorder((_req, res) => res.writeHead(200, { "content-type": "text/event-stream" }).end(body), async (base, output) => {
    const response = await send(base, { path: "/v1internal:streamGenerateContent" });
    assert.deepEqual(response.body, body);
    const transcript = output.join("\n");
    assert.match(transcript, /SSE kind=line-cap/u);
    assert.match(transcript, /SSE event=2 bytes=\d+ .*\$\.candidates=array\(len=50\)/u);
    assert.doesNotMatch(transcript, /\$\.candidates\[49\]|m{65}/u);
    assert.match(transcript, /SSE kind=invalid-json/u);
    assert.doesNotMatch(transcript, /fake malformed payload/u);
    assert.match(transcript, /SSE TOTAL events=3/u);
  });
});

it("walks a body breadth first so a deep first field does not hide the later fields", OPTIONS, async () => {
  const sessionId = "fake-session-5e21";
  const userAgent = "fake-user-agent-0c7d";
  const parts = Array.from({ length: 4 }, () => Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`k${i}`, i])));
  const body = Buffer.from(JSON.stringify({
    request: {
      contents: Array.from({ length: 4 }, () => ({ role: "user", parts })),
      generationConfig: { maxOutputTokens: 8192 },
      toolConfig: { functionCallingConfig: { mode: "AUTO" } },
      sessionId,
    },
    requestType: "agent",
    userAgent,
  }));
  await withRecorder((req, res) => {
    req.resume();
    req.once("end", () => res.end());
  }, async (base, output) => {
    await send(base, {
      path: "/v1internal:generateContent",
      method: "POST",
      headers: { "content-type": "application/json", "content-length": body.length },
    }, body);
    const transcript = output.join("\n");
    for (const shape of [
      "$.request.contents=array(len=4)",
      "$.request.generationConfig.maxOutputTokens=number(8192)",
      "$.request.toolConfig.functionCallingConfig.mode=string(len=4)",
      "$.request.sessionId=string(len=17)",
      '$.requestType=string(len=5,value="agent")',
      "$.userAgent=string(len=20)",
    ]) assert.ok(transcript.includes(shape), `Missing transcript shape: ${shape}`);
    assert.ok(!transcript.includes(sessionId) && !transcript.includes(userAgent));
  });
});

it("decodes gzip bodies in the view only and relays the compressed bytes", OPTIONS, async () => {
  const requestProject = "fake-gz-project-a41c";
  const prompt = "fake gz prompt 9b0e";
  const responseProject = "fake-gz-project-77d2";
  const requestBody = gzipSync(JSON.stringify({
    project: requestProject,
    model: "gemini-fabricated",
    request: { contents: [{ role: "user", parts: [{ text: prompt }] }] },
  }));
  const responseBody = gzipSync(JSON.stringify({ currentTier: { id: "g1-pro-tier" }, cloudaicompanionProject: responseProject }));
  let received: { encoding: string | undefined; body: Buffer } | undefined;
  await withRecorder((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      received = { encoding: req.headers["content-encoding"], body: Buffer.concat(chunks) };
      res.writeHead(200, { "content-type": "application/json", "content-encoding": "gzip", "content-length": responseBody.length });
      res.end(responseBody);
    });
  }, async (base, output) => {
    const response = await send(base, {
      path: "/v1internal:loadCodeAssist",
      method: "POST",
      headers: { "content-type": "application/json", "content-encoding": "gzip", "content-length": requestBody.length },
    }, requestBody);
    assert.equal(received?.encoding, "gzip");
    assert.deepEqual(received.body, requestBody);
    assert.equal(response.headers["content-encoding"], "gzip");
    assert.deepEqual(response.body, responseBody);
    await waitForLine(output, /^#1 REQUEST BODY /u);
    await waitForLine(output, /^#1 RESPONSE BODY /u);
    const transcript = output.join("\n");
    for (const shape of [
      '#1 REQUEST BODY $=object',
      '$.model=string(len=17,value="gemini-fabricated")',
      "$.request.contents[0].parts[0].text=string(len=19)",
      "$.project=<len:",
      '#1 RESPONSE BODY $=object',
      '$.currentTier.id=string(len=11,value="g1-pro-tier")',
      "$.cloudaicompanionProject=<len:",
    ]) assert.ok(transcript.includes(shape), `Missing transcript shape: ${shape}`);
    for (const literal of [requestProject, prompt, responseProject]) {
      assert.ok(!transcript.includes(literal), `Transcript disclosed a fabricated value: ${literal}`);
    }
  });
});

it("prints only the kind of an invalid gzip body and relays its bytes", OPTIONS, async () => {
  const body = Buffer.from("fake not gzip 4d1a");
  await withRecorder((_req, res) => {
    res.writeHead(200, { "content-type": "application/json", "content-encoding": "gzip" }).end(body);
  }, async (base, output) => {
    const response = await send(base, { path: "/v1internal:fetchAvailableModels" });
    assert.deepEqual(response.body, body);
    await waitForLine(output, /^#1 RESPONSE BODY /u);
    const transcript = output.join("\n");
    assert.ok(transcript.includes("#1 RESPONSE BODY kind=invalid-gzip"), transcript);
    assert.doesNotMatch(transcript, /fake not gzip/u);
  });
});

it("stops the gzip view past the decode cap and still relays every byte", OPTIONS, async () => {
  const line = `data: ${"x".repeat(1024 * 1024)}\n`;
  const body = gzipSync(line.repeat(65));
  await withRecorder((_req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream", "content-encoding": "gzip" }).end(body);
  }, async (base, output) => {
    const response = await send(base, { path: "/v1internal:streamGenerateContent?alt=sse" });
    assert.deepEqual(response.body, body);
    await waitForLine(output, /^#1 SSE (?:TOTAL|kind=decode-cap)/u);
    const transcript = output.join("\n");
    assert.match(transcript, /#1 SSE kind=invalid-json/u);
    assert.match(transcript, /#1 SSE kind=decode-cap/u);
    assert.doesNotMatch(transcript, /SSE TOTAL/u);
  });
});

it("rejects an ambiguous target without forwarding it", OPTIONS, async () => {
  let forwardCount = 0;
  await withRecorder((_req, res) => {
    forwardCount++;
    res.end();
  }, async (base, output) => {
    const response = await send(base, { path: "//example.invalid/v1internal:generateContent?x=fake-query" });
    assert.equal(response.status, 400);
    assert.equal(forwardCount, 0);
    assert.doesNotMatch(output.join("\n"), /example\.invalid|fake-query/u);
  });
});

const runEntry = (upstream: string, port: string) => {
  const entry = fileURLToPath(new URL("../../e2e/capture/gemini-recorder.ts", import.meta.url));
  return spawnSync(process.execPath, ["--import", "tsx", entry], {
    env: { GEMINI_RECORDER_UPSTREAM: upstream, GEMINI_RECORDER_PORT: port },
    encoding: "utf8",
    timeout: TIMEOUT_MS,
  });
};

it("refuses a foreign upstream before listen and does not print its URL", OPTIONS, () => {
  const result = runEntry("https://127.0.0.1.example.invalid/fake-url-value", "4143");
  assert.equal(result.error, undefined);
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "gemini-recorder: upstream override must be an HTTP(S) loopback origin\n");
  assert.equal(result.stderr, "");
});

it("refuses an out-of-range port before listen", OPTIONS, () => {
  const result = runEntry("http://127.0.0.1", "65536");
  assert.equal(result.error, undefined);
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "gemini-recorder: port must be an integer from 1024 to 65535\n");
  assert.equal(result.stderr, "");
});

it("accepts only a bare loopback HTTP(S) origin and refuses others with a fixed message", OPTIONS, () => {
  const refusal = { name: "Error", message: "gemini-recorder: upstream override must be an HTTP(S) loopback origin" };
  for (const upstream of [
    "not a url",
    "ftp://127.0.0.1",
    "http://10.0.0.1",
    "http://[::2]",
    "http://127.0.0.1.example.invalid",
    "http://fake-user:fake-pass@127.0.0.1",
    "http://127.0.0.1/fake-path",
    "http://127.0.0.1/?fake=query",
    "http://127.0.0.1/#fake-fragment",
  ]) assert.throws(() => createGeminiRecorderServer({ upstream }), refusal, upstream);
  for (const upstream of ["http://127.0.0.1:4143", "https://localhost:4143", "http://[::1]:4143"]) {
    assert.doesNotThrow(() => createGeminiRecorderServer({ upstream }), upstream);
  }
});

it("keeps the Gemini recorder out of the build and the package files", OPTIONS, () => {
  const readRepoJson = (name: string): unknown => JSON.parse(readFileSync(new URL(`../../${name}`, import.meta.url), "utf8"));
  const build = readRepoJson("tsconfig.build.json") as { compilerOptions?: { rootDir?: string }; include?: unknown };
  // rootDir also fails the build when a src file imports a file outside src.
  assert.equal(build.compilerOptions?.rootDir, "src");
  assert.deepEqual(build.include, ["src/**/*.ts"]);
  const pkg = readRepoJson("package.json") as { files?: unknown };
  assert.ok(Array.isArray(pkg.files) && pkg.files.length > 0, "package.json must list the files it ships");
  for (const entry of pkg.files as unknown[]) {
    // Refuse e2e, a path under e2e, a leading glob and the repository root.
    assert.ok(typeof entry === "string" && !/^(?:\.?\/)?(?:e2e(?:\/|$)|\*|\.?\/?$)/u.test(entry), `package file entry: ${String(entry)}`);
  }
});
