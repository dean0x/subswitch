import assert from "node:assert/strict";
import { IncomingMessage, ServerResponse } from "node:http";
import { Socket } from "node:net";
import { describe, it, type TestContext } from "node:test";
import { notOptedInHandler } from "../../src/provider-opt-in.js";

// A fake provider: this id is never a real provider id.
const handler = () => notOptedInHandler("Not A Provider", "not-a-provider");
const EXPECTED_MESSAGE = "Not A Provider is not turned on. Add a \"providers.not-a-provider\" block to the user " +
  "configuration, or to a file selected with SUBSWITCH_CONFIG, then restart subswitch.";

interface Reply {
  readonly status: unknown;
  readonly contentType: unknown;
  readonly body: string;
}

/** A real response object; the spies call through and record what the handler wrote. */
const recordedResponse = (t: TestContext): { readonly res: ServerResponse; readonly replies: () => Reply[] } => {
  const res = new ServerResponse(new IncomingMessage(new Socket()));
  const writeHead = t.mock.method(res, "writeHead");
  const end = t.mock.method(res, "end");
  return {
    res,
    replies: () => writeHead.mock.calls.map((call, index) => ({
      status: call.arguments[0],
      contentType: (call.arguments[1] as Record<string, unknown> | undefined)?.["content-type"],
      body: String(end.mock.calls[index]?.arguments[0]),
    })),
  };
};

/** Record every access to the target, so a test can prove the handler never reads it. */
const recordAccess = <T extends object>(target: T, touches: string[]): T => new Proxy(target, {
  get: (object, key, receiver) => { touches.push(`get ${String(key)}`); return Reflect.get(object, key, receiver); },
  has: (object, key) => { touches.push(`has ${String(key)}`); return Reflect.has(object, key); },
  ownKeys: (object) => { touches.push("ownKeys"); return Reflect.ownKeys(object); },
  set: (object, key, value, receiver) => { touches.push(`set ${String(key)}`); return Reflect.set(object, key, value, receiver); },
});

const request = () => new IncomingMessage(new Socket());
const body = (model: string) => ({ model, max_tokens: 16, messages: [{ role: "user", content: "hello" }] });
const raw = (model: string) => Buffer.from(JSON.stringify(body(model)));

describe("notOptedInHandler", () => {
  it("answers a messages request with a fixed local 400 that names the providers block in the user configuration", async (t) => {
    const { res, replies } = recordedResponse(t);
    await handler().handleMessages(request(), res, raw("not-a-provider:fixture"), body("not-a-provider:fixture"), "fixture");
    const [reply] = replies();
    assert.equal(replies().length, 1);
    assert.equal(reply?.status, 400);
    assert.equal(reply?.contentType, "application/json");
    assert.deepEqual(JSON.parse(reply?.body ?? ""), {
      type: "error", error: { type: "invalid_request_error", message: EXPECTED_MESSAGE },
    });
    assert.doesNotMatch(reply?.body ?? "", /subswitch\.config\.json|project/i,
      "the reply never names a project file as the way to turn the provider on");
  });

  it("gives the same reply for every model and body, and never echoes the model", async (t) => {
    const first = recordedResponse(t);
    const second = recordedResponse(t);
    await handler().handleMessages(request(), first.res, raw("fixture-a"), body("fixture-a"), "fixture-a");
    await handler().handleMessages(request(), second.res, raw("fixture-b"), body("fixture-b"), "fixture-b");
    assert.deepEqual(second.replies(), first.replies());
    assert.doesNotMatch(first.replies()[0]?.body ?? "", /fixture-a/);
  });

  it("gives count_tokens the same reply as a messages request", async (t) => {
    const messages = recordedResponse(t);
    const countTokens = recordedResponse(t);
    const subject = handler();
    await subject.handleMessages(request(), messages.res, raw("fixture"), body("fixture"), "fixture");
    subject.handleCountTokens(request(), countTokens.res, raw("fixture"));
    assert.equal(countTokens.replies().length, 1);
    assert.deepEqual(countTokens.replies(), messages.replies());
  });

  it("does no I/O: it reads no request, no body and no network", async (t) => {
    const touches: string[] = [];
    const fetchSpy = t.mock.method(globalThis, "fetch", async () => new Response("{}"));
    const req = recordAccess(request(), touches);
    const parsed = recordAccess(body("fixture"), touches);
    const rawBody = recordAccess(raw("fixture"), touches);
    const subject = handler();
    const { res, replies } = recordedResponse(t);
    await subject.handleMessages(req, res, rawBody, parsed, "fixture");
    subject.handleCountTokens(req, recordedResponse(t).res, rawBody);

    assert.equal(replies()[0]?.status, 400);
    assert.deepEqual(touches, []);
    assert.equal(fetchSpy.mock.callCount(), 0);

    // Positive controls: both spies do see an access.
    void req.headers;
    await globalThis.fetch("https://fixture.invalid/");
    assert.equal(touches[0], "get headers");
    assert.equal(fetchSpy.mock.callCount(), 1);
  });
});
