/**
 * The Kimi live check: its live gate, its caps, its run rules, its user config check and
 * its evidence check. No test here starts the check, reads a real home or a sign-in file,
 * or sends a request off the loopback host. Every Kimi value is fabricated.
 */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, it, type TestContext } from "node:test";
import { loadConfig } from "../../src/config.js";
import {
  CAP_LIMITS, COOLDOWN_MS, CapLedger, KIMI_MESSAGES_URL, KIMI_TOKEN_URL, LIVE_PHRASE, MAX_BODY_BYTES, PROBE_MODEL,
  cappedClaudeForwarder, cappedKimiFetch, checkEvidence, checkUserConfig, emptyCounts, liveGate, main, parseArguments,
  reserveDispatch, verdict, type Counts, type Evidence, type Exercise, type GateIO, type DispatchKind, type LiveArguments,
} from "../../e2e/gates/kimi-live-check.js";

const ROOT = "/fabricated/evidence";

const gateIO = (overrides: Partial<GateIO> = {}, answer: { readonly line: string | undefined } = { line: LIVE_PHRASE }) => {
  const asked: string[] = [];
  const io: GateIO = {
    env: {}, stdinIsTTY: true, stdoutIsTTY: true,
    ask: async (prompt) => { asked.push(prompt); return answer.line; },
    ...overrides,
  };
  return { asked, io };
};

/** Run main with a recording check in place of the real one. */
const runMain = async (args: readonly string[], overrides: Partial<GateIO> = {}, answer: { readonly line: string | undefined } = { line: LIVE_PHRASE }) => {
  const { asked, io } = gateIO(overrides, answer);
  const runs: LiveArguments[] = [];
  const lines: string[] = [];
  const code = await main(args, { ...io, out: (line) => lines.push(line), run: async (parsed) => { runs.push(parsed); return true; } });
  return { code, runs, asked, lines };
};

describe("Kimi live check: the live gate", () => {
  it("pins the cap phrase to each cap value", () => {
    assert.equal(LIVE_PHRASE,
      "start the Kimi live check: 18 Kimi attempts, 4608 tokens, 256 tokens per request, 8 Claude requests, 1 refresh");
  });

  it("refuses under CI before it asks for the phrase", async () => {
    const { asked, io } = gateIO({ env: { CI: "true" } });
    assert.deepEqual(await liveGate(io), { ok: false, error: "ci" });
    assert.deepEqual(asked, []);
  });

  it("refuses without a TTY on stdin", async () => {
    const { asked, io } = gateIO({ stdinIsTTY: false });
    assert.deepEqual(await liveGate(io), { ok: false, error: "no_tty" });
    assert.deepEqual(asked, []);
  });

  it("refuses without a TTY on stdout", async () => {
    const { asked, io } = gateIO({ stdoutIsTTY: false });
    assert.deepEqual(await liveGate(io), { ok: false, error: "no_tty" });
    assert.deepEqual(asked, []);
  });

  for (const answer of ["yes", LIVE_PHRASE.replace("18", "19"), `${LIVE_PHRASE} now`, "", undefined]) {
    it(`refuses an answer that is not the phrase: ${JSON.stringify(answer)}`, async () => {
      const { io } = gateIO({}, { line: answer });
      assert.deepEqual(await liveGate(io), { ok: false, error: "phrase_mismatch" });
    });
  }

  it("accepts the exact phrase with a TTY on stdin and stdout", async () => {
    const { asked, io } = gateIO({}, { line: `${LIVE_PHRASE}\n` });
    assert.deepEqual(await liveGate(io), { ok: true, value: undefined });
    assert.equal(asked.length, 1);
    assert.ok(asked[0]?.includes(LIVE_PHRASE), "the prompt shows the phrase");
  });
});

describe("Kimi live check: the entry", () => {
  it("keeps the live cooldown at 75 seconds", () => {
    assert.equal(COOLDOWN_MS, 75_000);
  });

  it("runs the live check only after the gate passes", async () => {
    const refused = await runMain(["--live", "--evidence-root", ROOT], { stdinIsTTY: false });
    assert.equal(refused.code, 2);
    assert.deepEqual(refused.runs, []);
    assert.deepEqual(refused.lines, [JSON.stringify({ success: false, code: "no_tty" })]);

    const passed = await runMain(["--live", "--evidence-root", ROOT]);
    assert.equal(passed.code, 0);
    assert.deepEqual(passed.runs, [{ mode: "live", evidenceRoot: ROOT }]);
  });

  it("passes the dry-run arguments through without the live gate", async () => {
    const dry = await runMain(["--evidence-root", ROOT, "--dry-run"], { env: { CI: "true" }, stdinIsTTY: false, stdoutIsTTY: false });
    assert.equal(dry.code, 0);
    assert.deepEqual(dry.asked, [], "the dry run does not ask for the phrase");
    assert.deepEqual(dry.runs, [{ mode: "dry-run", evidenceRoot: ROOT }]);
  });

  for (const args of [[], ["--live"], ["--live", "--evidence-root"], ["--live", "--dry-run", "--evidence-root", ROOT],
    ["--live", "--evidence-root", ROOT, "--extra"], ["--live", "--evidence-root", "relative/evidence"],
    ["--live", "--evidence-root", "/fabricated/../evidence"], ["--live", "--evidence-root", "/fabricated/.kimi-code/evidence"],
    ["--live", "--evidence-root", "/fabricated/.claude"], ["--live", "--evidence-root", "/fabricated/evi\ndence"],
    ["--live", "--evidence-root", "--dry-run"]]) {
    it(`refuses the arguments ${JSON.stringify(args)} before the gate`, async () => {
      assert.equal(parseArguments(args), undefined);
      const result = await runMain(args);
      assert.equal(result.code, 2);
      assert.deepEqual(result.runs, []);
      assert.deepEqual(result.asked, []);
    });
  }
});

describe("Kimi live check: the caps", () => {
  it("pins the caps and the hard-coded Kimi URLs", () => {
    assert.deepEqual(CAP_LIMITS, { kimi: 18, kimiTokens: 4608, claude: 8, refresh: 1, loopback: 32 });
    assert.equal(MAX_BODY_BYTES, 4 * 1024 * 1024);
    assert.equal(KIMI_MESSAGES_URL, "https://api.kimi.ai/coding/v1/messages?beta=true");
    assert.equal(KIMI_TOKEN_URL, "https://auth.kimi.ai/api/oauth/token");
  });

  it("reserves one Kimi attempt and its token cap, and does not change the input counts", () => {
    const before = emptyCounts();
    assert.deepEqual(reserveDispatch(before, "kimi", 256), { ok: true, value: { ...emptyCounts(), kimi: 1, kimiTokens: 256 } });
    assert.deepEqual(before, emptyCounts());
  });

  it("admits the last Kimi attempt at the token cap and refuses the next one", () => {
    const last = reserveDispatch({ ...emptyCounts(), kimi: 17, kimiTokens: 4352 }, "kimi", 256);
    assert.deepEqual(last, { ok: true, value: { ...emptyCounts(), kimi: 18, kimiTokens: 4608 } });
    assert.deepEqual(reserveDispatch({ ...emptyCounts(), kimi: 1, kimiTokens: 4608 }, "kimi", 1), { ok: false, error: "cost_cap" });
  });

  const full: ReadonlyArray<readonly [DispatchKind, Counts]> = [
    ["kimi", { ...emptyCounts(), kimi: 18, kimiTokens: 18 }],
    ["claude", { ...emptyCounts(), claude: 8 }],
    ["claude_count", { ...emptyCounts(), claude: 8 }],
    ["refresh", { ...emptyCounts(), refresh: 1 }],
    ["loopback", { ...emptyCounts(), loopback: 32 }],
  ];
  for (const [kind, counts] of full) {
    it(`refuses a ${kind} dispatch past its cap with cost_cap`, () => {
      assert.deepEqual(reserveDispatch(counts, kind, 1), { ok: false, error: "cost_cap" });
    });
  }

  for (const cap of [0, -1, 257, 1.5, Number.NaN, Number.POSITIVE_INFINITY, undefined, "256"]) {
    it(`refuses the per-request output cap ${String(cap)} with request_cap`, () => {
      assert.deepEqual(reserveDispatch(emptyCounts(), "kimi", cap), { ok: false, error: "request_cap" });
      assert.deepEqual(reserveDispatch(emptyCounts(), "claude", cap), { ok: false, error: "request_cap" });
    });
  }

  it("needs no output cap for a token request, a count_tokens request or a loopback call", () => {
    for (const kind of ["refresh", "claude_count", "loopback"] as const) {
      assert.equal(reserveDispatch(emptyCounts(), kind, undefined).ok, true, kind);
    }
  });

  for (const counts of [{ kimi: -1 }, { kimi: 1.5 }, { kimi: Number.NaN }, { kimi: 19 }, { kimiTokens: 4609 }, { loopback: 33 }]) {
    it(`refuses a bad counter ${JSON.stringify(counts)} with broken_cap`, () => {
      assert.deepEqual(reserveDispatch({ ...emptyCounts(), ...counts }, "loopback"), { ok: false, error: "broken_cap" });
    });
  }
});

describe("Kimi live check: the capped Kimi fetch", () => {
  const body = (extra: Record<string, unknown> = {}): string =>
    JSON.stringify({ model: PROBE_MODEL, max_tokens: 256, stream: true, messages: [{ role: "user", content: "hi" }], ...extra });
  const recorder = (reply: () => Promise<Response> = async () => new Response("{}", { status: 200 })) => {
    const calls: { url: string; init: RequestInit | undefined }[] = [];
    const transport: typeof fetch = async (input, init) => { calls.push({ url: String(input), init }); return reply(); };
    return { calls, transport };
  };
  // No redirect value here: the capped fetch sets it, so the check below proves the override.
  const post = (text: string | URLSearchParams): RequestInit =>
    ({ method: "POST", headers: { authorization: "Bearer fabricated-kimi-access" }, body: text });

  it("reserves before it sends, and keeps the reservation when the send fails", async () => {
    const ledger = new CapLedger();
    const { calls, transport } = recorder(async () => { throw new TypeError("fabricated transport failure"); });
    await assert.rejects(cappedKimiFetch(ledger, transport)(KIMI_MESSAGES_URL, post(body())), /fabricated transport failure/);
    assert.deepEqual(ledger.counts, { ...emptyCounts(), kimi: 1, kimiTokens: 256 });
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.init?.redirect, "error");
  });

  it("refuses past the attempt cap with cost_cap, sends nothing and stops the check", async () => {
    const ledger = new CapLedger();
    ledger.counts = { ...emptyCounts(), kimi: 18, kimiTokens: 18 * 256 };
    const { calls, transport } = recorder();
    await assert.rejects(cappedKimiFetch(ledger, transport)(KIMI_MESSAGES_URL, post(body())), { message: "cost_cap" });
    assert.equal(calls.length, 0);
    assert.equal(ledger.failure, "dispatch_refused");
    assert.equal(ledger.stop.signal.aborted, true);
    assert.deepEqual(ledger.refusals, ["cost_cap"]);
  });

  it("refuses a bad counter with broken_cap and sends nothing", async () => {
    const ledger = new CapLedger();
    ledger.counts = { ...emptyCounts(), kimi: -1 };
    const { calls, transport } = recorder();
    await assert.rejects(cappedKimiFetch(ledger, transport)(KIMI_MESSAGES_URL, post(body())), { message: "broken_cap" });
    assert.equal(calls.length, 0);
  });

  for (const url of ["https://api.kimi.com/coding/v1/messages?beta=true", "https://api.kimi.ai/coding/v1/messages",
    "https://api.kimi.ai:444/coding/v1/messages?beta=true", "http://api.kimi.ai/coding/v1/messages?beta=true",
    "https://user@api.kimi.ai/coding/v1/messages?beta=true", `${KIMI_TOKEN_URL}?extra=1`, "https://auth.kimi.com/api/oauth/token",
    "https://api.anthropic.com/v1/messages", "http://127.0.0.1:9/coding/v1/messages?beta=true"]) {
    it(`refuses the destination ${url} before it sends`, async () => {
      const ledger = new CapLedger();
      const { calls, transport } = recorder();
      await assert.rejects(cappedKimiFetch(ledger, transport)(url, post(body())), { message: "unknown_destination" });
      assert.equal(calls.length, 0);
      assert.deepEqual(ledger.counts, emptyCounts());
    });
  }

  it("refuses a GET to the Kimi URL", async () => {
    const ledger = new CapLedger();
    const { calls, transport } = recorder();
    await assert.rejects(cappedKimiFetch(ledger, transport)(KIMI_MESSAGES_URL, { method: "GET" }), { message: "unknown_destination" });
    assert.equal(calls.length, 0);
  });

  const refusedBodies: ReadonlyArray<readonly [string, string, string]> = [
    ["a body over 4 MiB", body({ padding: "x".repeat(MAX_BODY_BYTES) }), "invalid_body"],
    ["a body that is not JSON", "not json", "invalid_body"],
    ["an output cap over 256", body({ max_tokens: 257 }), "request_cap"],
    ["no output cap", body({ max_tokens: undefined }), "request_cap"],
    ["a model other than the probe model", body({ model: "k3" }), "unexpected_model"],
  ];
  for (const [name, text, code] of refusedBodies) {
    it(`refuses ${name} with ${code} and sends nothing`, async () => {
      const ledger = new CapLedger();
      const { calls, transport } = recorder();
      await assert.rejects(cappedKimiFetch(ledger, transport)(KIMI_MESSAGES_URL, post(text)), { message: code });
      assert.equal(calls.length, 0);
    });
  }

  it("admits one token request and refuses a second one", async () => {
    const ledger = new CapLedger();
    const { calls, transport } = recorder();
    const grant = () => post(new URLSearchParams({ grant_type: "refresh_token", refresh_token: "fabricated-kimi-refresh" }));
    assert.equal((await cappedKimiFetch(ledger, transport)(KIMI_TOKEN_URL, grant())).status, 200);
    // The Kimi sign-in manager reads a TypeError with this cause code as "the request did not
    // leave", so a refused renewal leaves no recovery state in the Kimi home.
    await assert.rejects(cappedKimiFetch(ledger, transport)(KIMI_TOKEN_URL, grant()),
      (error: unknown) => error instanceof TypeError && error.message === "cost_cap" &&
        (error.cause as { code?: unknown } | undefined)?.code === "ECONNREFUSED");
    assert.equal(calls.length, 1);
    assert.equal(ledger.counts.refresh, 1);
  });
});

describe("Kimi live check: the capped Claude forwarder", () => {
  /** A loopback server whose handler reads the body and calls the capped forwarder, as the proxy does. */
  const serve = async (t: TestContext, ledger: CapLedger) => {
    const forwarded: string[] = [];
    const forward = cappedClaudeForwarder(ledger, (req, res) => {
      forwarded.push(req.url ?? "");
      res.writeHead(200, { "content-type": "application/json" }).end("{}");
    });
    const server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => forward(req, res, { kind: "complete", bytes: Buffer.concat(chunks) }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
    const { port } = server.address() as AddressInfo;
    const send = async (path: string, body?: unknown, method = "POST"): Promise<number> =>
      (await fetch(`http://127.0.0.1:${port}${path}`, { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })).status;
    return { forwarded, send };
  };

  it("forwards a Messages request with an output cap of 256 or less, and a count_tokens request", async (t) => {
    const ledger = new CapLedger();
    const { forwarded, send } = await serve(t, ledger);
    assert.equal(await send("/v1/messages", { model: "claude-fixture", max_tokens: 256 }), 200);
    assert.equal(await send("/v1/messages/count_tokens", { model: "claude-fixture" }), 200);
    assert.deepEqual(forwarded, ["/v1/messages", "/v1/messages/count_tokens"]);
    assert.deepEqual(ledger.counts, { ...emptyCounts(), claude: 2 });
  });

  const refused: ReadonlyArray<readonly [string, string, unknown, string, string]> = [
    ["an output cap over 256", "/v1/messages", { max_tokens: 257 }, "POST", "request_cap"],
    ["no output cap", "/v1/messages", { model: "claude-fixture" }, "POST", "request_cap"],
    ["another path", "/v1/complete", { max_tokens: 1 }, "POST", "unexpected_request"],
    ["another method", "/v1/models", undefined, "GET", "unexpected_request"],
  ];
  for (const [name, path, body, method, code] of refused) {
    it(`refuses ${name} with ${code} and forwards nothing`, async (t) => {
      const ledger = new CapLedger();
      const { forwarded, send } = await serve(t, ledger);
      assert.equal(await send(path, body, method), 400);
      assert.deepEqual(forwarded, []);
      assert.deepEqual(ledger.refusals, [code]);
    });
  }

  it("refuses the ninth Claude request with cost_cap and forwards nothing", async (t) => {
    const ledger = new CapLedger();
    ledger.counts = { ...emptyCounts(), claude: 8 };
    const { forwarded, send } = await serve(t, ledger);
    assert.equal(await send("/v1/messages", { max_tokens: 1 }), 400);
    assert.deepEqual(forwarded, []);
    assert.deepEqual(ledger.refusals, ["cost_cap"]);
  });
});

describe("Kimi live check: the run rules", () => {
  const passing = (): Exercise => ({
    probes: [], renewal: { expected: false, tokenPosts: 0, status: "none", storeChanged: false },
    session: { actionStarted: true, outcome: "complete", requests: 1, errorReplies: 0 },
    control: { published: true, removed: true }, cleanupOk: true,
  });
  /** A ledger with one Kimi request of the session that got a 2xx. */
  const sessionLedger = (): CapLedger => {
    const ledger = new CapLedger();
    ledger.phase = "session";
    ledger.record("kimi", false).status = "2xx";
    return ledger;
  };

  it("passes a run whose rules all hold", () => {
    assert.equal(verdict(passing(), sessionLedger()), undefined);
  });

  it("fails a run in which no Claude Code request came through the action ingress", () => {
    const run = passing();
    assert.equal(verdict({ ...run, session: { ...run.session, requests: 0 } }, sessionLedger()), "no_session_requests");
  });

  it("fails a run in which no Kimi request of the session got a 2xx", () => {
    const ledger = new CapLedger();
    ledger.record("kimi", false).status = "2xx";
    ledger.phase = "session";
    ledger.record("kimi", false).status = "4xx";
    assert.equal(verdict(passing(), ledger), "no_kimi_session_dispatch");
  });

  const broken: ReadonlyArray<readonly [string, Partial<Exercise>, string]> = [
    ["a cancelled action", { session: { actionStarted: true, outcome: "cancel", requests: 1, errorReplies: 0 } }, "action_not_completed"],
    ["an error reply to the client", { session: { actionStarted: true, outcome: "complete", requests: 2, errorReplies: 1 } }, "session_error_reply"],
    ["a due sign-in without a renewal", { renewal: { expected: true, tokenPosts: 0, status: "none", storeChanged: false } }, "renewal_missing"],
    ["a refused renewal", { renewal: { expected: false, tokenPosts: 1, status: "4xx", storeChanged: false } }, "renewal_failed"],
    ["a renewal that did not change the file", { renewal: { expected: false, tokenPosts: 1, status: "2xx", storeChanged: false } }, "renewal_failed"],
    ["a control file left in place", { cleanupOk: false }, "cleanup_failed"],
  ];
  for (const [name, change, code] of broken) {
    it(`fails ${name} with ${code}`, () => {
      assert.equal(verdict({ ...passing(), ...change }, sessionLedger()), code);
    });
  }

  it("keeps the first failure of the run", () => {
    const ledger = sessionLedger();
    ledger.fail("probe_failed");
    ledger.fail("session_timeout");
    assert.equal(verdict(passing(), ledger), "probe_failed");
  });
});

describe("Kimi live check: the user config", () => {
  const HOME = "/fabricated-home";
  const loaded = (text: string) => loadConfig({
    env: { HOME }, homeDir: HOME, cwd: "/fabricated-project", allowProjectPort: false,
    readFile: (path) => {
      if (path === `${HOME}/.config/subswitch/config.json`) return text;
      throw Object.assign(new Error("absent"), { code: "ENOENT" });
    },
  });

  it("refuses a user config with a providers.kimi block", () => {
    assert.deepEqual(checkUserConfig(loaded(JSON.stringify({ providers: { kimi: {} } }))), { ok: false, error: "user_config_has_kimi_block" });
  });

  it("takes the port from a user config without the block", () => {
    assert.deepEqual(checkUserConfig(loaded(JSON.stringify({ port: 4999 }))), { ok: true, value: { port: 4999 } });
  });

  it("refuses a user config that does not load", () => {
    assert.deepEqual(checkUserConfig(loaded("{ not json")), { ok: false, error: "user_config_invalid" });
  });
});

describe("Kimi live check: the evidence", () => {
  const sample = (): Evidence => ({
    schemaVersion: 1, mode: "dry-run", success: true, failure: null, durationMs: 1200, cooldownMs: 75_000,
    caps: { limits: CAP_LIMITS, used: { ...emptyCounts(), kimi: 6, kimiTokens: 1536, refresh: 1, loopback: 9 } },
    refusals: [], probes: [{ name: "stream", status: "2xx", ok: true }, { name: "cancel", status: "2xx", ok: true }],
    renewal: { expected: true, tokenPosts: 1, status: "2xx", storeChanged: true },
    session: { actionStarted: true, outcome: "complete", requests: 1, errorReplies: 0, kimiDispatches: 1, claudeDispatches: 0,
      switchObserved: false, toolRoundTrip: false },
    kimiCodes: ["lock_busy"], control: { published: true, removed: true }, cleanupOk: true,
  });
  const LEAKS = [
    "/Users/someone/.kimi-code/credentials/kimi-code.json", "~/.kimi-code", "C:\\Users\\someone", "relative/folder/file.json",
    "someone@example.com", "sk-ant-oat01-FAKEFAKEFAKEFAKEFAKE", "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4In0.c2lnbmF0dXJl",
    "0123456789abcdef0123456789abcdef", "2026-11-20T10:00:00.000Z",
  ];

  it("accepts a report of counts, status classes, fixed codes and booleans", () => {
    assert.equal(checkEvidence(sample()), true);
  });

  for (const leak of LEAKS) {
    it(`rejects the string ${JSON.stringify(leak)} in any field`, () => {
      const base = sample();
      const reports: unknown[] = [
        { ...base, failure: leak },
        { ...base, probes: [{ name: leak, status: "2xx", ok: true }] },
        { ...base, kimiCodes: [leak] },
        { ...base, session: { ...base.session, outcome: leak } },
        { ...base, refusals: [leak] },
      ];
      for (const report of reports) assert.equal(checkEvidence(report), false, JSON.stringify(report));
    });
  }

  it("rejects a key outside the fixed field set, such as one shaped like a path, an e-mail or a token", () => {
    const base = sample();
    for (const key of ["/Users/someone", "someone@example.com", "sk-ant-oat01-FAKEFAKEFAKE", "note"]) {
      assert.equal(checkEvidence({ ...base, [key]: true }), false, key);
      assert.equal(checkEvidence({ ...base, caps: { ...base.caps, [key]: 1 } }), false, key);
    }
  });

  it("rejects a negative, fractional or unsafe number, and a value of another type", () => {
    const base = sample();
    for (const durationMs of [-1, 1.5, 2 ** 60, Number.NaN]) assert.equal(checkEvidence({ ...base, durationMs }), false, String(durationMs));
    assert.equal(checkEvidence({ ...base, durationMs: 10n }), false);
    assert.equal(checkEvidence({ ...base, cleanupOk: () => true }), false);
  });
});
