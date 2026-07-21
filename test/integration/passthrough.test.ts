import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { startCroxy, startFakeUpstream, type CroxyInstance, type FakeUpstream } from "./fake-upstreams.js";

const cleanups: (() => Promise<void>)[] = [];
after(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup();
});

const setup = async (
  handler: Parameters<typeof startFakeUpstream>[0],
  limits: Record<string, unknown> = {},
): Promise<{ anthropic: FakeUpstream; croxy: CroxyInstance }> => {
  const anthropic = await startFakeUpstream(handler);
  const croxy = await startCroxy({ anthropic: { baseUrl: anthropic.url }, limits });
  cleanups.push(croxy.close, anthropic.close);
  return { anthropic, croxy };
};

describe("anthropic passthrough", () => {
  it("forwards method, path+query, auth headers, and body verbatim", async () => {
    const { anthropic, croxy } = await setup((_req, res) => {
      res.writeHead(200, { "content-type": "application/json", "request-id": "req_fake_1" });
      res.end(JSON.stringify({ id: "msg_ok" }));
    });

    const body = JSON.stringify({ model: "claude-sonnet-4-6", max_tokens: 32, messages: [{ role: "user", content: "hi" }] });
    const response = await fetch(`${croxy.url}/v1/messages?beta=true`, {
      method: "POST",
      headers: {
        authorization: "Bearer sk-ant-oat-FAKE-OAUTH",
        "anthropic-beta": "oauth-2025-04-20,interleaved-thinking-2025-05-14",
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
        "x-app": "cli",
      },
      body,
    });

    assert.equal(response.status, 200);
    assert.equal(response.headers.get("request-id"), "req_fake_1");
    assert.deepEqual(await response.json(), { id: "msg_ok" });

    const seen = anthropic.requests[0]!;
    assert.equal(seen.method, "POST");
    assert.equal(seen.url, "/v1/messages?beta=true");
    assert.equal(seen.headers["authorization"], "Bearer sk-ant-oat-FAKE-OAUTH");
    assert.equal(seen.headers["anthropic-beta"], "oauth-2025-04-20,interleaved-thinking-2025-05-14");
    assert.equal(seen.headers["anthropic-version"], "2023-06-01");
    assert.equal(seen.headers["x-app"], "cli");
    assert.equal(seen.body.toString("utf8"), body);
  });

  it("relays SSE responses byte-for-byte", async () => {
    const sse = [
      'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_1"}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hi"}}\n\n',
      'event: message_stop\ndata: {"type":"message_stop"}\n\n',
    ].join("");
    const { croxy } = await setup((_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(sse);
    });

    const response = await fetch(`${croxy.url}/v1/messages?beta=true`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "claude-sonnet-4-6", stream: true, messages: [] }),
    });
    assert.equal(response.headers.get("content-type"), "text/event-stream");
    assert.equal(await response.text(), sse);
  });

  it("passes through HEAD / and GET /v1/models without buffering", async () => {
    const { anthropic, croxy } = await setup((req, res) => {
      if (req.method === "HEAD") {
        res.writeHead(200, { "x-probe": "ok" });
        res.end();
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ data: [] }));
    });

    const head = await fetch(`${croxy.url}/`, { method: "HEAD" });
    assert.equal(head.status, 200);
    assert.equal(head.headers.get("x-probe"), "ok");

    const models = await fetch(`${croxy.url}/v1/models?limit=5`);
    assert.equal(models.status, 200);
    assert.equal(anthropic.requests[1]!.url, "/v1/models?limit=5");
  });

  it("responds 413 with an anthropic-shaped error when the body exceeds the cap", async () => {
    const { anthropic, croxy } = await setup(
      (_req, res) => {
        res.writeHead(200);
        res.end();
      },
      { maxBodyBytes: 1024 },
    );

    const response = await fetch(`${croxy.url}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: `{"model":"claude-sonnet-4-6","padding":"${"x".repeat(4096)}"}`,
    });
    assert.equal(response.status, 413);
    const body = (await response.json()) as { type: string; error: { type: string } };
    assert.equal(body.type, "error");
    assert.equal(body.error.type, "invalid_request_error");
    assert.equal(anthropic.requests.length, 0);
  });

  it("responds 502 anthropic-shaped when the upstream is unreachable", async () => {
    const anthropic = await startFakeUpstream((_req, res) => res.end());
    await anthropic.close();
    const croxy = await startCroxy({ anthropic: { baseUrl: anthropic.url } });
    cleanups.push(croxy.close);

    const response = await fetch(`${croxy.url}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "claude-sonnet-4-6", messages: [] }),
    });
    assert.equal(response.status, 502);
    const body = (await response.json()) as { error: { type: string } };
    assert.equal(body.error.type, "api_error");
  });
});
