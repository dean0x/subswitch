import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  makeAccessToken,
  makeAuthFileContent,
  sseHandler,
  startSubswitch,
  startFakeUpstream,
  type SubswitchInstance,
  type FakeUpstream,
  type UpstreamHandler,
} from "./fake-upstreams.js";

const FAR_FUTURE_MS = Date.now() + 24 * 3600 * 1000;

const loadSse = (name: string): string => readFileSync(new URL(`../fixtures/response/${name}`, import.meta.url), "utf8");
const loadRequest = (name: string): string => readFileSync(new URL(`../fixtures/request/${name}`, import.meta.url), "utf8");

const cleanups: (() => Promise<void>)[] = [];
after(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup();
});

interface Rig {
  readonly subswitch: SubswitchInstance;
  readonly codex: FakeUpstream;
  readonly anthropic: FakeUpstream;
  readonly oauth: FakeUpstream;
  readonly authFilePath: string;
}

const setupRig = async (codexHandler: UpstreamHandler, options: { authFileContent?: string } = {}): Promise<Rig> => {
  const codex = await startFakeUpstream(codexHandler);
  const anthropic = await startFakeUpstream((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ id: "msg_from_anthropic" }));
  });
  const oauth = await startFakeUpstream((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        // A later expiry than the auth-file token so the two JWTs differ.
        access_token: makeAccessToken(FAR_FUTURE_MS + 3_600_000),
        id_token: "id.rotated.x",
        refresh_token: "refresh-int-2",
      }),
    );
  });
  const dir = await mkdtemp(join(tmpdir(), "subswitch-test-"));
  const authFilePath = join(dir, "auth.json");
  await writeFile(authFilePath, options.authFileContent ?? makeAuthFileContent(makeAccessToken(FAR_FUTURE_MS)), "utf8");

  const subswitch = await startSubswitch({
    anthropic: { baseUrl: anthropic.url },
    providers: { codex: { baseUrl: codex.url, oauthTokenUrl: `${oauth.url}/token`, authFile: authFilePath } },
  });
  cleanups.push(subswitch.close, codex.close, anthropic.close, oauth.close);
  return { subswitch, codex, anthropic, oauth, authFilePath };
};

const postMessages = (subswitch: SubswitchInstance, body: string, path = "/v1/messages?beta=true"): Promise<Response> =>
  fetch(`${subswitch.url}${path}`, {
    method: "POST",
    headers: {
      authorization: "Bearer sk-ant-oat-CLAUDE-OAUTH",
      "anthropic-beta": "oauth-2025-04-20",
      "content-type": "application/json",
    },
    body,
  });

const sseFrameTypes = (sseText: string): string[] =>
  sseText
    .split("\n\n")
    .filter((frame) => frame.includes("data: "))
    .map((frame) => (JSON.parse(frame.split("\n").find((l) => l.startsWith("data: "))!.slice(6)) as { type: string }).type);

describe("codex leg", () => {
  it("translates request and response end-to-end with correct codex headers", async () => {
    const rig = await setupRig(sseHandler(loadSse("tool-call-with-reasoning.sse")));

    const response = await postMessages(rig.subswitch, loadRequest("simple-text.json"));
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type") ?? "", /text\/event-stream/);
    const text = await response.text();
    assert.deepEqual(sseFrameTypes(text), [
      "message_start",
      "content_block_start",
      "content_block_delta",
      "content_block_delta",
      "content_block_stop",
      "message_delta",
      "message_stop",
    ]);
    assert.match(text, /"type":"tool_use","id":"call_abc","name":"list_files"/);

    const seen = rig.codex.requests[0]!;
    assert.equal(seen.url, "/responses");
    assert.match(String(seen.headers["authorization"]), /^Bearer ey/);
    assert.equal(seen.headers["chatgpt-account-id"], "acct_integration_1");
    assert.equal(seen.headers["openai-beta"], "responses=experimental");
    assert.equal(seen.headers["originator"], "codex_cli_rs");
    assert.ok(typeof seen.headers["session_id"] === "string" && seen.headers["session_id"].length > 0);
    // The claude.ai OAuth credential must never leak to the codex leg.
    assert.equal(String(seen.headers["authorization"]).includes("sk-ant"), false);
    assert.equal("anthropic-beta" in seen.headers, false);

    const sent = JSON.parse(seen.body.toString("utf8")) as Record<string, unknown>;
    assert.equal(sent["model"], "gpt-5.5");
    assert.equal(sent["stream"], true);
    assert.equal(sent["store"], false);
    assert.deepEqual(sent["include"], ["reasoning.encrypted_content"]);
    assert.equal(sent["instructions"], "You are a helpful worker agent.");
    assert.equal(rig.anthropic.requests.length, 0);
    assert.equal(rig.oauth.requests.length, 0);
  });

  it("forwards output_config.effort to the codex upstream as reasoning.effort", async () => {
    const rig = await setupRig(sseHandler(loadSse("text-only.sse")));

    const body = JSON.stringify({
      model: "gpt-5.5",
      stream: true,
      messages: [{ role: "user", content: "hi" }],
      output_config: { effort: "low" },
    });
    const response = await postMessages(rig.subswitch, body);
    assert.equal(response.status, 200);
    await response.text();

    const sent = JSON.parse(rig.codex.requests[0]!.body.toString("utf8")) as Record<string, unknown>;
    assert.deepEqual(sent["reasoning"], { effort: "low" });
  });

  it("round-trips encrypted reasoning across two requests (acid test)", async () => {
    const scripts = [loadSse("tool-call-with-reasoning.sse"), loadSse("text-only.sse")];
    const rig = await setupRig((_req, res, _body, index) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(scripts[index]);
    });

    // Request 1 produces a tool call whose reasoning subswitch must cache.
    const first = await postMessages(rig.subswitch, loadRequest("simple-text.json"));
    assert.equal(first.status, 200);
    await first.text();

    // Request 2 echoes the assistant tool_use + tool_result back, as Claude Code would.
    const second = await postMessages(rig.subswitch, loadRequest("tool-roundtrip.json"));
    assert.equal(second.status, 200);
    await second.text();

    const sent = JSON.parse(rig.codex.requests[1]!.body.toString("utf8")) as { input: Record<string, unknown>[] };
    const reasoningIndex = sent.input.findIndex((item) => item["type"] === "reasoning");
    assert.notEqual(reasoningIndex, -1, "request 2 must carry the cached encrypted reasoning item");
    assert.equal(sent.input[reasoningIndex]!["encrypted_content"], "ENCRYPTED_REASONING_BLOB_1");
    const next = sent.input[reasoningIndex + 1]!;
    assert.equal(next["type"], "function_call", "reasoning item must sit directly before its function_call");
    assert.equal(next["call_id"], "call_abc");
    const output = sent.input.find((item) => item["type"] === "function_call_output");
    assert.equal(output?.["call_id"], "call_abc");
  });

  it("refreshes and retries exactly once on a pre-stream 401", async () => {
    const text = loadSse("text-only.sse");
    const rig = await setupRig((_req, res, _body, index) => {
      if (index === 0) {
        res.writeHead(401, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: "token expired" } }));
        return;
      }
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(text);
    });

    const response = await postMessages(rig.subswitch, loadRequest("simple-text.json"));
    assert.equal(response.status, 200);
    assert.match(await response.text(), /message_stop/);

    assert.equal(rig.oauth.requests.length, 1);
    assert.equal(rig.codex.requests.length, 2);
    assert.notEqual(rig.codex.requests[0]!.headers["authorization"], rig.codex.requests[1]!.headers["authorization"]);

    const authFile = JSON.parse(await readFile(rig.authFilePath, "utf8")) as Record<string, unknown>;
    assert.equal((authFile["tokens"] as Record<string, unknown>)["refresh_token"], "refresh-int-2");
    assert.deepEqual(authFile["future_cli_key"], { must: "survive" });
  });

  it("passes 429 through with retry-after and a rate_limit_error body", async () => {
    const rig = await setupRig((_req, res) => {
      res.writeHead(429, { "content-type": "application/json", "retry-after": "7" });
      res.end(JSON.stringify({ error: { message: "rate limited" } }));
    });

    const response = await postMessages(rig.subswitch, loadRequest("simple-text.json"));
    assert.equal(response.status, 429);
    assert.equal(response.headers.get("retry-after"), "7");
    const body = (await response.json()) as { error: { type: string } };
    assert.equal(body.error.type, "rate_limit_error");
  });

  it("answers count_tokens locally with the chars/4 estimate", async () => {
    const rig = await setupRig(sseHandler(loadSse("text-only.sse")));
    const body = JSON.stringify({ model: "gpt-5.5", messages: [{ role: "user", content: "estimate me" }] });
    const response = await postMessages(rig.subswitch, body, "/v1/messages/count_tokens");
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { input_tokens: Math.ceil(body.length / 4) });
    assert.equal(rig.codex.requests.length, 0);
  });

  it("routes claude models to anthropic even when the codex leg is configured", async () => {
    const rig = await setupRig(sseHandler(loadSse("text-only.sse")));
    const response = await postMessages(
      rig.subswitch,
      JSON.stringify({ model: "claude-sonnet-4-6", max_tokens: 16, messages: [{ role: "user", content: "hi" }] }),
    );
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { id: "msg_from_anthropic" });
    assert.equal(rig.codex.requests.length, 0);
    assert.equal(rig.anthropic.requests.length, 1);
  });

  it("aggregates the upstream stream for non-streaming clients", async () => {
    const rig = await setupRig(sseHandler(loadSse("text-only.sse")));
    const response = await postMessages(
      rig.subswitch,
      JSON.stringify({ model: "gpt-5.5", max_tokens: 64, messages: [{ role: "user", content: "hi" }] }),
    );
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type") ?? "", /application\/json/);
    const message = (await response.json()) as Record<string, unknown>;
    assert.equal(message["type"], "message");
    assert.equal(message["role"], "assistant");
    assert.deepEqual(message["content"], [{ type: "text", text: "Hello from codex" }]);
    assert.equal(message["stop_reason"], "end_turn");
  });

  it("degrades only the codex leg when the auth file is corrupt", async () => {
    const rig = await setupRig(sseHandler(loadSse("text-only.sse")), { authFileContent: "not json at all" });

    const codexResponse = await postMessages(rig.subswitch, loadRequest("simple-text.json"));
    assert.equal(codexResponse.status, 401);
    const body = (await codexResponse.json()) as { error: { type: string; message: string } };
    assert.equal(body.error.type, "authentication_error");
    assert.match(body.error.message, /codex login/);

    const anthropicResponse = await postMessages(
      rig.subswitch,
      JSON.stringify({ model: "claude-sonnet-4-6", max_tokens: 16, messages: [{ role: "user", content: "hi" }] }),
    );
    assert.equal(anthropicResponse.status, 200);
    assert.deepEqual(await anthropicResponse.json(), { id: "msg_from_anthropic" });
  });

  // F10: auth file ENOENT — the error message must include `codex login` so the
  // user knows how to recover (not just "cannot read file" with no action).
  it("F10 — returns 401 with 'codex login' instruction when auth file does not exist", async () => {
    const dir = await mkdtemp(join(tmpdir(), "subswitch-f10-test-"));
    const anthropic = await startFakeUpstream((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ id: "msg_from_anthropic" }));
    });
    const subswitch = await startSubswitch(
      {
        anthropic: { baseUrl: anthropic.url },
        // Point authFile at a path that does not exist — ENOENT scenario.
        providers: { codex: { authFile: join(dir, "auth-does-not-exist.json") } },
      },
    );
    try {
      const codexResponse = await postMessages(
        subswitch,
        // gpt-5.6-sol routes to codex; auth failure surfaces there.
        JSON.stringify({ model: "gpt-5.6-sol", max_tokens: 16, messages: [{ role: "user", content: "hi" }] }),
      );
      assert.equal(codexResponse.status, 401, "ENOENT auth file must return 401");
      const body = (await codexResponse.json()) as { error: { type: string; message: string } };
      assert.equal(body.error.type, "authentication_error");
      assert.match(body.error.message, /codex login/, "error message must instruct user to run 'codex login'");

      // Anthropic fallback must still work (codex leg degradation, not full outage).
      const anthropicResponse = await postMessages(
        subswitch,
        JSON.stringify({ model: "claude-sonnet-4-6", max_tokens: 16, messages: [{ role: "user", content: "hi" }] }),
      );
      assert.equal(anthropicResponse.status, 200, "Anthropic fallback must still work after codex auth failure");
    } finally {
      await subswitch.close();
      await anthropic.close();
    }
  });

  it("sets the user-agent header from codex.userAgent config", async () => {
    const rig = await setupRig(sseHandler(loadSse("text-only.sse")));
    const response = await postMessages(rig.subswitch, loadRequest("simple-text.json"));
    assert.equal(response.status, 200);
    await response.text();

    const seen = rig.codex.requests[0]!;
    // The default UA must be set explicitly and match the configured knob.
    assert.ok(
      typeof seen.headers["user-agent"] === "string" && seen.headers["user-agent"].length > 0,
      "user-agent header must be present",
    );
    assert.match(seen.headers["user-agent"] as string, /codex_cli_rs\/\d+/);
    // originator and openai-beta must remain unchanged (hard rule: verified working against /responses 2026-07-21)
    assert.equal(seen.headers["originator"], "codex_cli_rs");
    assert.equal(seen.headers["openai-beta"], "responses=experimental");
  });

  it("sends a custom user-agent when codex.userAgent is overridden in config", async () => {
    const codex = await startFakeUpstream(sseHandler(loadSse("text-only.sse")));
    const anthropic = await startFakeUpstream((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ id: "msg_from_anthropic" }));
    });
    const oauth = await startFakeUpstream((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ access_token: makeAccessToken(Date.now() + 3_600_000) }));
    });
    const dir = await mkdtemp(join(tmpdir(), "subswitch-test-ua-"));
    const authFilePath = join(dir, "auth.json");
    await writeFile(authFilePath, makeAuthFileContent(makeAccessToken(Date.now() + 3_600_000)), "utf8");

    const subswitch = await startSubswitch({
      anthropic: { baseUrl: anthropic.url },
      providers: { codex: {
        baseUrl: codex.url,
        oauthTokenUrl: `${oauth.url}/token`,
        authFile: authFilePath,
        userAgent: "my-custom-agent/1.0",
      } },
    });
    cleanups.push(subswitch.close, codex.close, anthropic.close, oauth.close);

    const response = await fetch(`${subswitch.url}/v1/messages?beta=true`, {
      method: "POST",
      headers: { authorization: "Bearer sk-ant", "anthropic-beta": "oauth-2025-04-20", "content-type": "application/json" },
      body: loadRequest("simple-text.json"),
    });
    assert.equal(response.status, 200);
    await response.text();
    assert.equal(codex.requests[0]!.headers["user-agent"], "my-custom-agent/1.0");
  });

  it("session_id is stable across two turns of the same conversation", async () => {
    const scripts = [loadSse("text-only.sse"), loadSse("text-only.sse")];
    const rig = await setupRig((_req, res, _body, index) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(scripts[index]);
    });

    // Send the same request twice — same model + system + first user message → same derived key.
    const first = await postMessages(rig.subswitch, loadRequest("simple-text.json"));
    await first.text();
    const second = await postMessages(rig.subswitch, loadRequest("simple-text.json"));
    await second.text();

    const id1 = rig.codex.requests[0]!.headers["session_id"];
    const id2 = rig.codex.requests[1]!.headers["session_id"];
    assert.ok(typeof id1 === "string" && id1.length > 0);
    assert.equal(id1, id2, "session_id must be stable across turns of the same conversation");
  });

  it("session_id is stable across the 401→refresh→retry path (same session on retry)", async () => {
    const text = loadSse("text-only.sse");
    const rig = await setupRig((_req, res, _body, index) => {
      if (index === 0) {
        res.writeHead(401, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: "token expired" } }));
        return;
      }
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(text);
    });

    const response = await postMessages(rig.subswitch, loadRequest("simple-text.json"));
    assert.equal(response.status, 200);
    await response.text();

    const id0 = rig.codex.requests[0]!.headers["session_id"];
    const id1 = rig.codex.requests[1]!.headers["session_id"];
    assert.ok(typeof id0 === "string" && id0.length > 0);
    // Same request → same conversation key → same session_id, even though the auth token changed.
    assert.equal(id0, id1, "session_id must not change between the initial attempt and the auth retry");
    // Auth token must have changed (proves the retry path was exercised).
    assert.notEqual(
      rig.codex.requests[0]!.headers["authorization"],
      rig.codex.requests[1]!.headers["authorization"],
    );
  });

  it("session_id differs across distinct conversations (different first user messages)", async () => {
    const scripts = [loadSse("text-only.sse"), loadSse("text-only.sse")];
    const rig = await setupRig((_req, res, _body, index) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(scripts[index]);
    });

    const req1 = JSON.stringify({ model: "gpt-5.5", stream: true, messages: [{ role: "user", content: "conversation A" }] });
    const req2 = JSON.stringify({ model: "gpt-5.5", stream: true, messages: [{ role: "user", content: "conversation B" }] });

    const r1 = await postMessages(rig.subswitch, req1);
    await r1.text();
    const r2 = await postMessages(rig.subswitch, req2);
    await r2.text();

    const id1 = rig.codex.requests[0]!.headers["session_id"];
    const id2 = rig.codex.requests[1]!.headers["session_id"];
    assert.ok(typeof id1 === "string" && id1.length > 0);
    assert.ok(typeof id2 === "string" && id2.length > 0);
    assert.notEqual(id1, id2, "distinct conversations must produce distinct session_ids");
  });

  // ---------------------------------------------------------------------------
  // Unclosed content-block regression tests (paths a, b, c/d).
  // These run on the NON-STREAMING path so they exercise aggregateFrames.
  // ---------------------------------------------------------------------------

  it("path a: recovers content when response.completed fires before output_item.done (flush synthesis)", async () => {
    const rig = await setupRig(sseHandler(loadSse("completed-before-done.sse")));
    const response = await postMessages(
      rig.subswitch,
      JSON.stringify({ model: "gpt-5.5", messages: [{ role: "user", content: "hi" }] }),
    );
    // Must be 200 with non-empty content — never a 200 with empty content.
    assert.equal(response.status, 200);
    const message = (await response.json()) as Record<string, unknown>;
    const content = message["content"] as unknown[];
    assert.deepEqual(content, [{ type: "text", text: "Hello" }]);
  });

  it("path b: recovers content when stream ends with no response.completed (flush synthesis)", async () => {
    const rig = await setupRig(sseHandler(loadSse("eof-mid-block.sse")));
    const response = await postMessages(
      rig.subswitch,
      JSON.stringify({ model: "gpt-5.5", messages: [{ role: "user", content: "hi" }] }),
    );
    // Must be 200 with non-empty content — the synthesised stop preserves accumulated deltas.
    assert.equal(response.status, 200);
    const message = (await response.json()) as Record<string, unknown>;
    const content = message["content"] as unknown[];
    assert.deepEqual(content, [{ type: "text", text: "Partial text" }]);
  });

  it("path c: returns 502 when a block has unmatched deltas (content unrecoverable)", async () => {
    // done-without-id.sse: output_item.added has neither item.id nor output_index;
    // all deltas are unmatched; flush() must emit an error frame instead of empty content.
    const rig = await setupRig(sseHandler(loadSse("done-without-id.sse")));
    const response = await postMessages(
      rig.subswitch,
      JSON.stringify({ model: "gpt-5.5", messages: [{ role: "user", content: "hi" }] }),
    );
    // Must be 502 — a 200 with empty content is the data-loss bug we are preventing.
    assert.equal(response.status, 502);
    const body = (await response.json()) as { error: { type: string } };
    assert.equal(body.error.type, "api_error");
  });

  // P1-4 path (d): done.item.id differs from added.item.id but output_index matches.
  // Current behaviour (verified by probing): content is preserved via the output_index
  // fallback lookup.  This test closes a test gap, not a behaviour gap.
  it("path d: returns 200 with content when output_item.done carries a different id than added", async () => {
    const rig = await setupRig(sseHandler(loadSse("done-id-mismatch.sse")));
    const response = await postMessages(
      rig.subswitch,
      JSON.stringify({ model: "gpt-5.5", messages: [{ role: "user", content: "hi" }] }),
    );
    assert.equal(response.status, 200);
    const message = (await response.json()) as Record<string, unknown>;
    assert.deepEqual(message["content"], [{ type: "text", text: "hello world" }]);
  });

  // P0-1: function_call block with truncated arguments must return 502, not 200 with input:{}.
  it("returns 502 when a function_call block has truncated (unparseable) arguments", async () => {
    const truncatedToolArgs = [
      'event: response.created',
      'data: {"type":"response.created","response":{"id":"r6","model":"gpt-5.5","status":"in_progress"}}',
      '',
      'event: response.output_item.added',
      'data: {"type":"response.output_item.added","output_index":0,"item":{"type":"function_call","id":"fc1","call_id":"call_x","name":"write_file"}}',
      '',
      'event: response.function_call_arguments.delta',
      'data: {"type":"response.function_call_arguments.delta","item_id":"fc1","output_index":0,"delta":"{\\"path\\":\\"/etc/hosts\\",\\"content\\":\\"DAN"}',
      '',
      'event: response.completed',
      'data: {"type":"response.completed","response":{"id":"r6","model":"gpt-5.5","status":"completed","usage":{"input_tokens":5,"output_tokens":3}}}',
      '',
      '',
    ].join('\n');
    const rig = await setupRig((_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(truncatedToolArgs);
    });
    const response = await postMessages(
      rig.subswitch,
      JSON.stringify({ model: "gpt-5.5", messages: [{ role: "user", content: "hi" }] }),
    );
    assert.equal(response.status, 502);
    const body = (await response.json()) as { error: { type: string } };
    assert.equal(body.error.type, "api_error");
  });

  // P0-2 Variant A: block opened, no delta, EOF before terminal event → 502, not 200 with empty content.
  it("returns 502 when a block is opened but EOF arrives before any delta or terminal event", async () => {
    const truncatedNoContent = [
      'event: response.created',
      'data: {"type":"response.created","response":{"id":"r7","model":"gpt-5.5","status":"in_progress"}}',
      '',
      'event: response.output_item.added',
      'data: {"type":"response.output_item.added","output_index":0,"item":{"type":"message","id":"m7","role":"assistant"}}',
      '',
      '',
    ].join('\n');
    const rig = await setupRig((_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(truncatedNoContent);
    });
    const response = await postMessages(
      rig.subswitch,
      JSON.stringify({ model: "gpt-5.5", messages: [{ role: "user", content: "hi" }] }),
    );
    assert.equal(response.status, 502);
    const body = (await response.json()) as { error: { type: string } };
    assert.equal(body.error.type, "api_error");
  });

  // P0-2 Variant B: response.created only, no blocks, EOF before terminal event → 502, not 200 with content:[].
  it("returns 502 when stream ends after response.created with no output blocks and no terminal event", async () => {
    const truncatedNoBlocks = [
      'event: response.created',
      'data: {"type":"response.created","response":{"id":"r9","model":"gpt-5.5","status":"in_progress"}}',
      '',
      '',
    ].join('\n');
    const rig = await setupRig((_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(truncatedNoBlocks);
    });
    const response = await postMessages(
      rig.subswitch,
      JSON.stringify({ model: "gpt-5.5", messages: [{ role: "user", content: "hi" }] }),
    );
    assert.equal(response.status, 502);
    const body = (await response.json()) as { error: { type: string } };
    assert.equal(body.error.type, "api_error");
  });

  // P1-5: mid-stream upstream destroy on the non-streaming path must return 502.
  it("shapes mid-stream upstream failures as a 502 on the non-streaming path", async () => {
    const rig = await setupRig((_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write('event: response.created\ndata: {"type":"response.created","response":{"id":"resp_x","model":"gpt-5.5"}}\n\n');
      setTimeout(() => res.destroy(), 30);
    });
    const response = await postMessages(
      rig.subswitch,
      JSON.stringify({ model: "gpt-5.5", messages: [{ role: "user", content: "hi" }] }),
    );
    assert.equal(response.status, 502);
    const body = (await response.json()) as { error: { type: string; message: string } };
    assert.equal(body.error.type, "api_error");
    assert.match(body.error.message, /codex stream interrupted/);
  });

  it("aggregation !ok maps to 502 (no message_start in stream)", async () => {
    // A stream with only unknown events produces no message_start; aggregateFrames
    // returns err(...), which the handler must map to 502 api_error.
    const rig = await setupRig((_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end('event: unknown.event\ndata: {"type":"unknown.event"}\n\n');
    });
    const response = await postMessages(
      rig.subswitch,
      JSON.stringify({ model: "gpt-5.5", messages: [{ role: "user", content: "hi" }] }),
    );
    assert.equal(response.status, 502);
    const body = (await response.json()) as { error: { type: string } };
    assert.equal(body.error.type, "api_error");
  });

  it("shapes mid-stream upstream failures as an SSE error event", async () => {
    const rig = await setupRig((_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write('event: response.created\ndata: {"type":"response.created","response":{"id":"resp_x","model":"gpt-5.5"}}\n\n');
      setTimeout(() => res.destroy(), 30);
    });

    const response = await postMessages(rig.subswitch, loadRequest("simple-text.json"));
    assert.equal(response.status, 200);
    const text = await response.text();
    assert.match(text, /event: message_start/);
    assert.match(text, /event: error/);
    assert.match(text, /codex stream interrupted/);
    assert.equal(rig.codex.requests.length, 1, "mid-stream failures must not be retried");
  });

  // ---------------------------------------------------------------------------
  // Phase B: alias resolution — model string no longer does double duty
  // ---------------------------------------------------------------------------

  it("sends the canonical model id upstream when a derived family alias is used in the request", async () => {
    // Default config uses the built-in model registry — all non-retired registry ids are routable.
    // "sol" is a derived family alias for "gpt-5.6-sol".
    const rig = await setupRig(sseHandler(loadSse("text-only.sse")));
    const body = JSON.stringify({ model: "sol", stream: true, messages: [{ role: "user", content: "hi" }] });
    const response = await postMessages(rig.subswitch, body);
    assert.equal(response.status, 200);
    await response.text();
    const sent = JSON.parse(rig.codex.requests[0]!.body.toString("utf8")) as Record<string, unknown>;
    assert.equal(sent["model"], "gpt-5.6-sol", "alias must be resolved to canonical before going upstream");
    assert.equal(rig.anthropic.requests.length, 0, "alias for a codex model must not leak to Anthropic");
  });

  it("routes a derived family alias to the Codex leg (not Anthropic)", async () => {
    const rig = await setupRig(sseHandler(loadSse("text-only.sse")));
    const body = JSON.stringify({ model: "sol", stream: true, messages: [{ role: "user", content: "hi" }] });
    const response = await postMessages(rig.subswitch, body);
    assert.equal(response.status, 200);
    await response.text();
    assert.equal(rig.codex.requests.length, 1, "request with alias must reach the Codex upstream");
    assert.equal(rig.anthropic.requests.length, 0);
  });

  it("answers count_tokens for a derived alias via the Codex leg (handled locally)", async () => {
    const rig = await setupRig(sseHandler(loadSse("text-only.sse")));
    const body = JSON.stringify({ model: "sol", messages: [{ role: "user", content: "estimate me" }] });
    const response = await postMessages(rig.subswitch, body, "/v1/messages/count_tokens");
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { input_tokens: Math.ceil(body.length / 4) });
    assert.equal(rig.anthropic.requests.length, 0, "count_tokens alias must not leak to Anthropic");
  });

  it("alias and its canonical produce the same session_id and prompt_cache_key", async () => {
    // This test is the critical invariant of Phase B: canonical threading ensures that
    // a user sending "sol" and a user sending "gpt-5.6-sol" share a conversation id.
    const scripts = [loadSse("text-only.sse"), loadSse("text-only.sse")];
    const rig = await setupRig((_req, res, _body, index) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(scripts[index]);
    });

    const userMsg = [{ role: "user", content: "same conversation content" }];
    const reqAlias = JSON.stringify({ model: "sol", stream: true, messages: userMsg });
    const reqCanonical = JSON.stringify({ model: "gpt-5.6-sol", stream: true, messages: userMsg });

    const r1 = await postMessages(rig.subswitch, reqAlias);
    await r1.text();
    const r2 = await postMessages(rig.subswitch, reqCanonical);
    await r2.text();

    const req1 = rig.codex.requests[0]!;
    const req2 = rig.codex.requests[1]!;

    const sid1 = req1.headers["session_id"];
    const sid2 = req2.headers["session_id"];
    assert.ok(typeof sid1 === "string" && sid1.length > 0, "session_id must be present");
    assert.equal(sid1, sid2, "alias and canonical must produce the same session_id");

    const body1 = JSON.parse(req1.body.toString("utf8")) as Record<string, unknown>;
    const body2 = JSON.parse(req2.body.toString("utf8")) as Record<string, unknown>;
    assert.ok(typeof body1["prompt_cache_key"] === "string", "prompt_cache_key must be present for canonical request");
    assert.equal(
      body1["prompt_cache_key"],
      body2["prompt_cache_key"],
      "alias and canonical must produce the same prompt_cache_key",
    );
  });

  it("message_start falls back to the canonical model id when upstream omits model in response.created", async () => {
    // When response.created carries no model, options.model (which must be canonical) is the fallback.
    const rig = await setupRig((_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(
        [
          'event: response.created',
          'data: {"type":"response.created","response":{"id":"resp_alias_test","status":"in_progress"}}',
          '',
          'event: response.completed',
          'data: {"type":"response.completed","response":{"id":"resp_alias_test","status":"completed","usage":{"input_tokens":1,"output_tokens":0}}}',
          '',
        ].join('\n'),
      );
    });
    const body = JSON.stringify({ model: "sol", stream: true, messages: [{ role: "user", content: "hi" }] });
    const response = await postMessages(rig.subswitch, body);
    assert.equal(response.status, 200);
    const text = await response.text();
    const startFrame = text.split("\n\n").find((f) => f.includes('"type":"message_start"'));
    assert.ok(startFrame !== undefined, "message_start frame must be present");
    const startLine = startFrame.split("\n").find((l) => l.startsWith("data: "));
    assert.ok(startLine !== undefined);
    const startData = JSON.parse(startLine.slice(6)) as { message: { model: string } };
    assert.equal(startData.message.model, "gpt-5.6-sol", "options.model fallback must be the canonical, not the alias");
  });

  it("a codex.aliases config override routes a non-registry id upstream and proves override precedence", async () => {
    // Overriding 'sol' to 'gpt-9-sol' (not in registry) verifies:
    //   1. config override takes precedence over the derived family alias
    //   2. the override target becomes routable via the alias map
    //   3. the upstream receives the exact override target
    const codex = await startFakeUpstream(sseHandler(loadSse("text-only.sse")));
    const anthropic = await startFakeUpstream((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ id: "msg_from_anthropic" }));
    });
    const oauth = await startFakeUpstream((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ access_token: makeAccessToken(Date.now() + 3_600_000) }));
    });
    const dir = await mkdtemp(join(tmpdir(), "subswitch-test-alias-override-"));
    const authFilePath = join(dir, "auth.json");
    await writeFile(authFilePath, makeAuthFileContent(makeAccessToken(FAR_FUTURE_MS)), "utf8");

    const subswitch = await startSubswitch({
      anthropic: { baseUrl: anthropic.url },
      providers: { codex: {
        baseUrl: codex.url,
        oauthTokenUrl: `${oauth.url}/token`,
        authFile: authFilePath,
        aliases: { sol: "gpt-9-sol" },
      } },
    });
    cleanups.push(subswitch.close, codex.close, anthropic.close, oauth.close);

    const response = await fetch(`${subswitch.url}/v1/messages?beta=true`, {
      method: "POST",
      headers: { authorization: "Bearer sk-ant", "anthropic-beta": "oauth-2025-04-20", "content-type": "application/json" },
      body: JSON.stringify({ model: "sol", stream: true, messages: [{ role: "user", content: "hi" }] }),
    });
    assert.equal(response.status, 200);
    await response.text();
    const sent = JSON.parse(codex.requests[0]!.body.toString("utf8")) as Record<string, unknown>;
    assert.equal(sent["model"], "gpt-9-sol", "config override target must be sent upstream");
    assert.equal(anthropic.requests.length, 0, "config override must route to Codex, not Anthropic");
  });
});
