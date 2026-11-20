/**
 * The Kimi leg through the server. Fake upstreams stand in for Kimi, the Kimi token service,
 * Anthropic, Codex, Together and the OpenAI side of the Codex client. Each Kimi home is a
 * fabricated mkdtemp folder through realpath, HOME names it while the config loads, and the
 * Kimi sign-in file store runs on it. No test reads a real home, sign-in file or store, and
 * no request leaves the loopback host.
 */
import { describe, it, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../../src/config.js";
import { KIMI_REGION_TABLE } from "../../src/kimi-constants.js";
import { toKimiProxyError } from "../../src/kimi-errors.js";
import type { KimiStoreDeps } from "../../src/kimi-native-auth.js";
import { createKimiNativeStore } from "../../src/kimi-native-store.js";
import { KIMI_REPLY_ERRORS } from "../../src/kimi-stream.js";
import type { Item } from "../../src/routing/routing-types.js";
import { TOGETHER_API_KEY_ENV, type TogetherKeyReaderDeps } from "../../src/together-auth.js";
import { messageFrames, nativeEvents } from "../fixtures/native-messages.js";
import { nativeCredential } from "../fixtures/native-profile.js";
import { lateToolNames } from "../fixtures/together/streams.js";
import { recordFsPaths } from "../helpers/fs-path-recorder.js";
import {
  makeAccessToken, makeAuthFileContent, sseHandler, startFakeUpstream, startSubswitch, type FakeUpstream, type RecordedRequest,
  type UpstreamHandler,
} from "./fake-upstreams.js";

const SLOT = KIMI_REGION_TABLE.global.credentialFile;
/** The Kimi CLI client id, spelled here apart from the code. */
const CLIENT_ID = "17e5f671-d194-4dfb-9706-5516cb48c098";
/** Every Kimi token of this file starts with this marker. */
const KIMI_TOKEN = "FAKE-KIMI-TOKEN-";
const ACCESS = `${KIMI_TOKEN}ACCESS-0001`;
const REFRESH = `${KIMI_TOKEN}REFRESH-0001`;
const RENEWED = `${KIMI_TOKEN}ACCESS-0002`;
const ROTATED = `${KIMI_TOKEN}REFRESH-0002`;
const KIMI_SIGNATURE = "FAKE-KIMI-SIGNATURE-0001";
const KIMI_THOUGHT = "FAKE-KIMI-THOUGHT about the fixture";
const KIMI_TOOL_ID = "toolu_kimi_fixture";
const CLAUDE_SIGNATURE = "FAKE-CLAUDE-SIGNATURE-0001";
const ALIAS = "fixture-kimi-alias";
const CLIENT_SIGN_IN = "Bearer sk-ant-oat01-FAKE-CLIENT-SIGN-IN";
const CLIENT_KEY = "sk-ant-api03-FAKE-CLIENT-KEY";
const CLIENT_BETA = "oauth-2025-04-20,fake-client-beta-0001";
const CLIENT_ACCOUNT = "FAKE-CLIENT-ACCOUNT-0001";
const CLIENT_HEADERS = { authorization: CLIENT_SIGN_IN, "x-api-key": CLIENT_KEY, "anthropic-beta": CLIENT_BETA };
const KIMI_DETAIL = { type: "error", error: { type: "api_error", message: "FAKE Kimi upstream detail" } };

const READ_TOOL = { name: "Read", description: "Read a fixture file", input_schema: { type: "object", properties: { path: { type: "string" } } } };
const HELLO: readonly Item[] = [{ role: "user", content: "hi" }];
const CLAUDE_CONTENT: Item[] = [
  { type: "thinking", thinking: "Claude thought about the fixture", signature: CLAUDE_SIGNATURE },
  { type: "text", text: "Claude answer" },
];
const KIMI_TOOL_TURN: Item[] = [
  { type: "thinking", thinking: KIMI_THOUGHT, signature: KIMI_SIGNATURE },
  { type: "tool_use", id: KIMI_TOOL_ID, name: "Read", input: { path: "fixture.txt" } },
];

const chatRequest = (model: string, messages: readonly Item[], extra: Item = {}): Item =>
  ({ model, max_tokens: 64, stream: true, tools: [READ_TOOL], messages, ...extra });
const sse = (content: Item[]): string => messageFrames(nativeEvents(content)).join("");
const sseReply = (content: Item[]): UpstreamHandler => (_req, res) => {
  res.writeHead(200, { "content-type": "text/event-stream" });
  res.end(sse(content));
};
const jsonReply = (status: number, body: unknown, headers: Record<string, string> = {}): UpstreamHandler => (_req, res) => {
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(JSON.stringify(body));
};
const tokenReply = jsonReply(200, { access_token: RENEWED, refresh_token: ROTATED, token_type: "Bearer", expires_in: 3600, scope: "kimi-code" });
const requestText = (request: RecordedRequest): string => JSON.stringify(request.headers) + request.body.toString();
const bodyOf = (request: RecordedRequest | undefined): Item => JSON.parse(request?.body.toString() ?? "null") as Item;

const thinkingBlocks = (request: Item): Item[] => (request["messages"] as Item[])
  .flatMap((message) => (Array.isArray(message["content"]) ? message["content"] as Item[] : []))
  .filter((block) => block["type"] === "thinking" || block["type"] === "redacted_thinking");

/**
 * A simulated rule of the Anthropic service: a thinking block with a signature that the
 * fake did not give gets a 400. Otherwise the reply is signed Claude thinking and text.
 */
const signedReply = (request: Item): readonly [number, string] => (
  thinkingBlocks(request).every((block) => block["signature"] === CLAUDE_SIGNATURE)
    ? [200, sse(CLAUDE_CONTENT)]
    : [400, JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "Invalid signature in thinking block" } })]);
const signingAnthropic: UpstreamHandler = (_req, res, body) => {
  const [status, text] = signedReply(JSON.parse(body.toString()) as Item);
  res.writeHead(status, { "content-type": status === 200 ? "text/event-stream" : "application/json" });
  res.end(text);
};
/** The first-party endpoint of an explicit route, with the same simulated signature rule. */
const signingFetch = (bodies: Item[]): typeof fetch => async (input, init) => {
  assert.equal(String(input), "https://api.anthropic.com/v1/messages", "the route calls only the first-party endpoint");
  assert.equal(init?.redirect, "error");
  const body = JSON.parse(String(init?.body)) as Item;
  bodies.push(body);
  const [status, text] = signedReply(body);
  return new Response(text, { status, headers: { "content-type": status === 200 ? "text/event-stream" : "application/json" } });
};
/** The Kimi side of one session: thinking and a tool call first, then text. */
const kimiSession: UpstreamHandler = (req, res, body, index) =>
  sseReply(index === 0 ? KIMI_TOOL_TURN : [{ type: "text", text: "Kimi answer" }])(req, res, body, index);

/** The assistant content that a client builds from a stream, as Claude Code does. */
const assistantContent = (stream: string): Item[] => {
  const blocks: Item[] = [];
  const json: string[] = [];
  for (const frame of stream.split("\n\n")) {
    const data = frame.split("\n").find((line) => line.startsWith("data: "));
    if (data === undefined) continue;
    const event = JSON.parse(data.slice("data: ".length)) as Item;
    const index = Number(event["index"]);
    const delta = (event["delta"] ?? {}) as Item;
    const block = blocks[index];
    if (event["type"] === "content_block_start") {
      blocks[index] = { ...(event["content_block"] as Item) };
      json[index] = "";
    } else if (event["type"] === "content_block_delta" && block !== undefined) {
      for (const [field, type] of [["text", "text_delta"], ["thinking", "thinking_delta"], ["signature", "signature_delta"]] as const) {
        if (delta["type"] === type) block[field] = `${String(block[field] ?? "")}${String(delta[field])}`;
      }
      if (delta["type"] === "input_json_delta") json[index] = `${json[index] ?? ""}${String(delta["partial_json"])}`;
    } else if (event["type"] === "content_block_stop" && block?.["type"] === "tool_use" && json[index] !== "") {
      block["input"] = JSON.parse(json[index] ?? "{}");
    }
  }
  return blocks;
};

/** Run `body` while HOME names `home`, so each default sign-in path is a fixture path. */
const withHome = async <T>(home: string, body: () => Promise<T>): Promise<T> => {
  const previous = process.env["HOME"];
  process.env["HOME"] = home;
  try {
    return await body();
  } finally {
    if (previous === undefined) delete process.env["HOME"];
    else process.env["HOME"] = previous;
  }
};

interface Reply { readonly status: number; readonly headers: string; readonly text: string }

interface RigOptions {
  /** False: no providers.kimi block. */
  readonly block?: boolean;
  /** The Kimi Messages fake, or "closed" for a host that refuses the connection. */
  readonly kimi?: UpstreamHandler | "closed";
  readonly anthropic?: UpstreamHandler;
  readonly signInFile?: "missing";
  /** Turn on the Codex client ingress, with or without its Claude translation. */
  readonly codexIngress?: { readonly claude: boolean };
  /** Add an explicit route "work" to a first-party Claude profile. The route requests go to this list. */
  readonly explicitRoute?: Item[];
}

/** A Subswitch with the file-store Kimi deps on a fabricated Kimi home, and a live Codex and Together leg. */
const startRig = async (t: TestContext, options: RigOptions = {}) => {
  const root = await mkdtemp(join(await realpath(tmpdir()), "subswitch-kimi-leg-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const kimiFolder = join(root, ".kimi-code");
  await mkdir(join(kimiFolder, "credentials"), { recursive: true, mode: 0o700 });
  const authFile = join(kimiFolder, "credentials", SLOT);
  if (options.signInFile !== "missing") {
    const record = { access_token: ACCESS, refresh_token: REFRESH, expires_at: Math.floor(Date.now() / 1000) + 3600,
      scope: "kimi-code", token_type: "Bearer", expires_in: 3600 };
    await writeFile(authFile, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
  }
  const codexAuthFile = join(root, "codex-auth.json");
  await writeFile(codexAuthFile, makeAuthFileContent(makeAccessToken(Date.now() + 24 * 3600 * 1000)), { mode: 0o600 });

  const kimiHandler = options.kimi ?? sseReply([{ type: "text", text: "Kimi answer" }]);
  const kimi = await startFakeUpstream(kimiHandler === "closed" ? sseReply([]) : kimiHandler);
  const token = await startFakeUpstream(tokenReply);
  const anthropic = await startFakeUpstream(options.anthropic ?? sseReply([{ type: "text", text: "Claude answer" }]));
  const codex = await startFakeUpstream(sseHandler(readFileSync(new URL("../fixtures/response/text-only.sse", import.meta.url), "utf8")));
  const together = await startFakeUpstream(sseHandler(lateToolNames));
  const openai = await startFakeUpstream(jsonReply(400,
    { error: { message: "The model does not exist", type: "invalid_request_error", code: "model_not_found" } }));
  t.after(async () => { for (const fake of [kimi, token, anthropic, codex, together, openai]) await fake.close(); });
  if (kimiHandler === "closed") await kimi.close();

  const kimiDeps: KimiStoreDeps = { openStore: (file) => createKimiNativeStore(file), fetch, now: Date.now };
  const togetherDeps: TogetherKeyReaderDeps = {
    env: { [TOGETHER_API_KEY_ENV]: "FAKE-TOGETHER-KEY-kimi-leg" }, platform: "linux", setTimer: () => () => {},
    exec: async () => { throw new Error("no Keychain read in this test"); },
  };
  const routed = options.explicitRoute;
  const logs: string[] = [];
  const subswitch = await withHome(root, () => startSubswitch({
    anthropic: { baseUrl: anthropic.url },
    providers: {
      codex: { baseUrl: codex.url, authFile: codexAuthFile },
      together: { baseUrl: `${together.url}/v1` },
      ...(options.block === false ? {} : { kimi: {
        authFile, baseUrl: `${kimi.url}/coding/v1`, oauthTokenUrl: `${token.url}/api/oauth/token`, aliases: { [ALIAS]: "k3" },
      } }),
    },
    ...(options.codexIngress === undefined ? {} : { codexIngress: {
      enabled: true, apiBaseUrl: `${openai.url}/v1`, subscriptionBaseUrl: `${openai.url}/backend-api/codex`,
      claude: { enabled: options.codexIngress.claude },
    } }),
    ...(routed === undefined ? {} : {
      configVersion: 2,
      accessProfiles: { native: {
        provider: "claude", product: "claude-code", billing: "subscription", account: "kimi-leg", baseUrl: "https://api.anthropic.com",
        credential: nativeCredential("claude", "fabricated-kimi-leg"),
      } },
      routes: { work: { clients: ["claude-code"], primary: { profile: "native", model: "claude-sonnet-5", effort: "high" } } },
    }),
  }, {
    logger: { log: (level, event, fields) => logs.push(`${level} ${event} ${JSON.stringify(fields ?? {})}`) },
    providerDeps: { kimi: kimiDeps, together: togetherDeps },
    ...(routed === undefined ? {} : { fetchImpl: signingFetch(routed) }),
    // Fail closed before a store is made: the sign-in path must be in the fabricated home.
    checkConfig: (config) => assert.equal(config.providers.kimi.authFile, authFile),
  }));
  t.after(subswitch.close);

  const post = async (body: Item, headers: Record<string, string> = {}, path = "/v1/messages"): Promise<Reply> => {
    const response = await fetch(`${subswitch.url}${path}`, {
      method: "POST", headers: { "content-type": "application/json", "anthropic-version": "2023-06-01", ...headers },
      body: JSON.stringify(body),
    });
    return { status: response.status, headers: JSON.stringify([...response.headers.entries()]), text: await response.text() };
  };
  return {
    url: subswitch.url, refused: subswitch.refusedStoreCalls, kimiFolder, authFile, logs, post,
    kimi, token, anthropic, codex, together, openai,
  };
};
type Rig = Awaited<ReturnType<typeof startRig>>;

const errorOf = (reply: Reply): { type: string; message: string } =>
  (JSON.parse(reply.text) as { error: { type: string; message: string } }).error;
const counts = (fakes: readonly FakeUpstream[]): number[] => fakes.map((fake) => fake.requests.length);

describe("Kimi leg: the block turns the route on", () => {
  it("without the block, each Kimi name gets the fixed local error, and nothing reads the Kimi home", async (t) => {
    const rig = await startRig(t, { block: false });
    const seen: string[] = [];
    const stop = recordFsPaths(rig.kimiFolder, (call, path) => seen.push(`${call} ${path}`));
    const replies: Reply[] = [];
    try {
      for (const model of ["k3", "kimi:k3"]) replies.push(await rig.post(chatRequest(model, HELLO)));
      replies.push(await rig.post(chatRequest("k3", HELLO), {}, "/v1/messages/count_tokens"));
    } finally {
      stop();
    }
    for (const reply of replies) {
      assert.equal(reply.status, 400);
      assert.match(errorOf(reply).message, /^Kimi is not turned on\. Add a "providers\.kimi" block/);
    }
    assert.deepEqual(seen, [], "no file call under the Kimi home");
    assert.deepEqual(counts([rig.kimi, rig.token, rig.anthropic]), [0, 0, 0], "no Kimi request and no other route");
    assert.deepEqual(rig.refused, []);
  });

  it("with the block, each Kimi name reaches Kimi and the leg reads the sign-in file (positive control)", async (t) => {
    const rig = await startRig(t);
    const seen: string[] = [];
    const stop = recordFsPaths(rig.kimiFolder, (call, path) => seen.push(`${call} ${path}`));
    try {
      for (const model of ["k3", "kimi:k3", ALIAS]) assert.equal((await rig.post(chatRequest(model, HELLO))).status, 200, model);
    } finally {
      stop();
    }
    assert.deepEqual(rig.kimi.requests.map((request) => [request.url, bodyOf(request)["model"]]),
      Array.from({ length: 3 }, () => ["/coding/v1/messages?beta=true", "k3"]));
    assert.ok(seen.some((line) => line.endsWith(` ${rig.authFile}`)), `the store reads the sign-in file: ${seen.join(", ")}`);
    assert.equal(rig.anthropic.requests.length, 0);
  });
});

describe("Kimi leg: credential leak rows", () => {
  const leakRequest = chatRequest("k3", HELLO, { metadata: { user_id: CLIENT_ACCOUNT } });
  /** One Kimi request with every client sign-in value. The Kimi fake must have the Kimi bearer. */
  const kimiRequest = async (rig: Rig): Promise<RecordedRequest> => {
    assert.equal((await rig.post(leakRequest, CLIENT_HEADERS)).status, 200);
    assert.equal(rig.kimi.requests.length, 1);
    const request = rig.kimi.requests[0]!;
    assert.equal(request.headers["authorization"], `Bearer ${ACCESS}`, "the Kimi bearer reached Kimi, so the row is live");
    return request;
  };
  const rows: ReadonlyArray<{ readonly name: string; readonly check: (request: RecordedRequest) => void }> = [
    { name: "the client authorization never reaches Kimi", check: (request) => {
      assert.equal(requestText(request).includes("FAKE-CLIENT-SIGN-IN"), false);
    } },
    { name: "the client x-api-key never reaches Kimi", check: (request) => {
      assert.equal(request.headers["x-api-key"], undefined);
      assert.equal(requestText(request).includes(CLIENT_KEY), false);
    } },
    { name: "the client anthropic-beta values never reach Kimi", check: (request) => {
      assert.equal(request.headers["anthropic-beta"], undefined);
      assert.equal(requestText(request).includes("fake-client-beta"), false);
    } },
    { name: "the client metadata never reaches Kimi", check: (request) => {
      assert.equal("metadata" in bodyOf(request), false);
      assert.equal(requestText(request).includes(CLIENT_ACCOUNT), false);
    } },
  ];
  for (const row of rows) {
    it(row.name, async (t) => {
      row.check(await kimiRequest(await startRig(t)));
    });
  }

  it("the Kimi bearer never reaches the Anthropic leg, which gets the client sign-in as sent", async (t) => {
    const rig = await startRig(t);
    await kimiRequest(rig);
    assert.equal((await rig.post(chatRequest("claude-sonnet-4-6", HELLO), CLIENT_HEADERS)).status, 200);
    assert.equal(rig.anthropic.requests.length, 1);
    const request = rig.anthropic.requests[0]!;
    assert.equal(request.headers["authorization"], CLIENT_SIGN_IN);
    assert.equal(requestText(request).includes(KIMI_TOKEN), false);
  });

  it("no Kimi token reaches a client response or a log, also when Kimi echoes it in an error", async (t) => {
    const echo: UpstreamHandler = (req, res, body, index) => (index === 0 ? sseReply([{ type: "text", text: "Kimi answer" }])
      : jsonReply(400, { error: { type: "invalid_request_error", message: `refused ${String(req.headers["authorization"]).slice(7)}` } })
    )(req, res, body, index);
    const rig = await startRig(t, { kimi: echo });
    const replies = [await rig.post(chatRequest("k3", HELLO)), await rig.post(chatRequest("k3", HELLO, { stream: false }))];
    assert.deepEqual(replies.map((reply) => reply.status), [200, 400]);
    assert.deepEqual(rig.kimi.requests.map((request) => request.headers["authorization"]), [`Bearer ${ACCESS}`, `Bearer ${ACCESS}`]);
    for (const [surface, text] of [["client replies", replies.map((reply) => reply.headers + reply.text).join("\n")],
      ["log records", rig.logs.join("\n")]] as const) {
      assert.equal(text.includes(KIMI_TOKEN), false, `no Kimi token in the ${surface}`);
    }
  });
});

describe("Kimi leg: a Claude and Kimi session", () => {
  /** Claude, Kimi with a tool call, Kimi with the tool result, then Claude. Each request has the whole history. */
  const runSession = async (rig: Rig, claudeModel: string) => {
    const messages: Item[] = [{ role: "user", content: "Read the fixture file" }];
    const replies: Reply[] = [];
    const turn = async (model: string, next: Item): Promise<void> => {
      const reply = await rig.post(chatRequest(model, messages));
      replies.push(reply);
      messages.push({ role: "assistant", content: assistantContent(reply.text) }, next);
    };
    await turn(claudeModel, { role: "user", content: "Now ask Kimi" });
    await turn("k3", { role: "user", content: [{ type: "tool_result", tool_use_id: KIMI_TOOL_ID, content: "fixture text" }] });
    await turn("k3", { role: "user", content: "Back to Claude" });
    await turn(claudeModel, { role: "user", content: "Done" });
    return { replies, messages };
  };

  /** The rules of the switch on the Kimi side, and what the client got from Kimi. */
  const checkKimiSide = (rig: Rig, replies: readonly Reply[]): void => {
    assert.deepEqual(replies.map((reply) => reply.status), [200, 200, 200, 200], replies.map((reply) => reply.text).join("\n"));
    for (const reply of replies) assert.match(reply.text, /event: message_stop/);
    for (const reply of [replies[1]!, replies[2]!]) {
      assert.deepEqual(assistantContent(reply.text).filter((block) => block["type"] !== "text" && block["type"] !== "tool_use"), [],
        "the client gets no Kimi thinking block");
      assert.equal(reply.text.includes(KIMI_SIGNATURE) || reply.text.includes("FAKE-KIMI-THOUGHT"), false);
    }
    assert.equal(rig.kimi.requests.length, 2);
    const [first, second] = rig.kimi.requests.map(bodyOf);
    assert.deepEqual(thinkingBlocks(first!), [], "no Claude thinking reaches Kimi");
    assert.equal(JSON.stringify(first).includes(CLAUDE_SIGNATURE), false);
    const kimiTurns = (second!["messages"] as Item[]).filter((message) => message["role"] === "assistant");
    assert.deepEqual(kimiTurns.at(-1)?.["content"], KIMI_TOOL_TURN, "Kimi gets its own thinking back from the server cache");
    assert.deepEqual(thinkingBlocks(second!), [KIMI_TOOL_TURN[0]], "Kimi gets no Claude thinking in the later turn");
  };

  it("switches Claude to Kimi and back with no 400, and Kimi thinking stays on the server", async (t) => {
    const rig = await startRig(t, { kimi: kimiSession, anthropic: signingAnthropic });
    const { replies } = await runSession(rig, "claude-sonnet-4-6");
    checkKimiSide(rig, replies);
    assert.equal(rig.anthropic.requests.length, 2);
    const last = rig.anthropic.requests[1]!;
    assert.deepEqual(thinkingBlocks(bodyOf(last)).map((block) => block["signature"]), [CLAUDE_SIGNATURE],
      "Claude gets its own signed thinking back, and no Kimi thinking");
    assert.equal(requestText(last).includes(KIMI_SIGNATURE) || requestText(last).includes(KIMI_TOKEN), false);
  });

  it("an explicit first-party Claude route gets no Kimi thinking block to own after a Kimi turn", async (t) => {
    const routed: Item[] = [];
    const rig = await startRig(t, { kimi: kimiSession, explicitRoute: routed });
    const { replies } = await runSession(rig, "work");
    checkKimiSide(rig, replies);
    assert.equal(rig.anthropic.requests.length, 0, "the route does not use the Anthropic pass-through");
    assert.equal(routed.length, 2);
    assert.deepEqual(thinkingBlocks(routed[1]!).map((block) => block["signature"]), [CLAUDE_SIGNATURE]);
    assert.equal(JSON.stringify(routed[1]).includes(KIMI_SIGNATURE), false);
  });

  it("an explicit route can not name Kimi, so Kimi output never enters the route replay cache", () => {
    const loaded = loadConfig({ configPath: "kimi-route.json", globalConfigPath: false, env: {}, readFile: () => JSON.stringify({
      configVersion: 2,
      accessProfiles: { kimi: {
        provider: "kimi", product: "claude-code", billing: "subscription", account: "kimi-leg", baseUrl: "https://api.kimi.ai/coding/v1",
        credential: nativeCredential("claude", "fabricated-kimi-route"),
      } },
      routes: { kimi: { clients: ["claude-code"], primary: { profile: "kimi", model: "k3", effort: "high" } } },
    }) });
    assert.equal(loaded.ok, false);
    if (!loaded.ok) assert.match(loaded.error.message, /provider/);
  });
});

describe("Kimi leg: sign-in renewal", () => {
  it("after a 401, renews the sign-in once and sends the request again with the new bearer", async (t) => {
    const rig = await startRig(t, { kimi: (req, res, body, index) =>
      (index === 0 ? jsonReply(401, KIMI_DETAIL) : sseReply([{ type: "text", text: "Kimi answer" }]))(req, res, body, index) });
    const reply = await rig.post(chatRequest("k3", HELLO));
    assert.equal(reply.status, 200);
    assert.deepEqual(rig.kimi.requests.map((request) => request.headers["authorization"]), [`Bearer ${ACCESS}`, `Bearer ${RENEWED}`]);
    assert.deepEqual(rig.token.requests.map((request) => [request.url, Object.fromEntries(new URLSearchParams(request.body.toString()))]),
      [["/api/oauth/token", { client_id: CLIENT_ID, grant_type: "refresh_token", refresh_token: REFRESH }]]);
    const saved = JSON.parse(await readFile(rig.authFile, "utf8")) as Item;
    assert.deepEqual([saved["access_token"], saved["refresh_token"]], [RENEWED, ROTATED], "the renewal is saved");
    assert.equal((reply.headers + reply.text + rig.logs.join("\n")).includes(KIMI_TOKEN), false);
    assert.deepEqual(counts([rig.anthropic, rig.codex, rig.together]), [0, 0, 0]);
  });
});

describe("Kimi leg: no fallback", () => {
  const errorFrame: UpstreamHandler = (_req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end(messageFrames([nativeEvents([])[0]!, { type: "error", error: { type: "overloaded_error", message: "FAKE Kimi upstream detail" } }]).join(""));
  };
  const rows: ReadonlyArray<{
    readonly name: string; readonly options: RigOptions; readonly status: number; readonly type: string; readonly message?: string;
    readonly renewals?: number;
  }> = [
    { name: "a 500 status", options: { kimi: jsonReply(500, KIMI_DETAIL) }, status: 500, type: "api_error" },
    { name: "a 429 status", options: { kimi: jsonReply(429, KIMI_DETAIL, { "retry-after": "7" }) }, status: 429, type: "rate_limit_error" },
    { name: "a 401 status after its one renewal", options: { kimi: jsonReply(401, KIMI_DETAIL) }, status: 401,
      type: "authentication_error", renewals: 1 },
    { name: "an error frame in the stream", options: { kimi: errorFrame }, status: 502, type: "api_error" },
    { name: "a Kimi host that refuses the connection", options: { kimi: "closed" }, status: 502, type: "api_error",
      message: "Kimi upstream unreachable" },
    { name: "a missing sign-in file", options: { signInFile: "missing" }, status: 401, type: "authentication_error",
      message: toKimiProxyError("credential_missing").message },
  ];
  for (const row of rows) {
    it(`after ${row.name}, gives the fixed error and sends nothing to another route`, async (t) => {
      const rig = await startRig(t, row.options);
      const reply = await rig.post(chatRequest("k3", HELLO, { stream: false }));
      assert.equal(reply.status, row.status, reply.text);
      const expected = row.message ?? KIMI_REPLY_ERRORS[row.type as keyof typeof KIMI_REPLY_ERRORS];
      assert.deepEqual(errorOf(reply), { type: row.type, message: expected });
      assert.equal(reply.text.includes("FAKE Kimi upstream detail"), false);
      assert.equal(rig.token.requests.length, row.renewals ?? 0);
      assert.deepEqual(counts([rig.anthropic, rig.codex, rig.together]), [0, 0, 0], "no fallback request");
      // Positive control: each other route is live in this instance.
      for (const model of ["claude-sonnet-4-6", "gpt-5.5", "together:fixture/ok"]) await rig.post(chatRequest(model, HELLO, { stream: false }));
      assert.deepEqual(counts([rig.anthropic, rig.codex, rig.together]), [1, 1, 1]);
    });
  }
});

describe("Kimi leg: the Codex client ingress", () => {
  for (const claude of [false, true]) {
    it(`never sends a Codex client request for a Kimi model to Kimi, with Claude translation ${claude ? "on" : "off"}`, async (t) => {
      const rig = await startRig(t, { codexIngress: { claude } });
      for (const model of ["k3", "kimi:k3", ALIAS]) {
        const body = { model, input: "hi", stream: false };
        const reply = await rig.post(body, { authorization: "Bearer FAKE-CODEX-CLIENT-SIGN-IN" }, "/codex/v1/responses");
        assert.equal(reply.status, 400, "the OpenAI side gives its own refusal");
        assert.equal(JSON.parse(reply.text).error.code, "model_not_found");
        assert.deepEqual(bodyOf(rig.openai.requests.at(-1)), body);
      }
      assert.equal(rig.openai.requests.length, 3);
      assert.deepEqual(counts([rig.kimi, rig.token, rig.anthropic]), [0, 0, 0]);
      assert.deepEqual(rig.refused, []);
      // Positive control: a Claude Code request for the same model reaches Kimi in this instance.
      assert.equal((await rig.post(chatRequest("k3", HELLO))).status, 200);
      assert.equal(rig.kimi.requests.length, 1);
    });
  }
});
