import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { it } from "node:test";
import { checkEvidence, liveGate, LIVE_PHRASE, main } from "../../e2e/gates/gemini-live-check.js";
import { BOOTSTRAP_URL, cappedFetch, createLedger, emptyCounts, GENERATE_URL } from "../../e2e/gates/gemini-live-caps.js";
import type { GateIO } from "../../e2e/gates/live-check-common.js";

it("TP-44: refuses CI, either missing TTY, and the wrong cap phrase before the check", async () => {
  const terminal: GateIO = { env: {}, stdinIsTTY: true, stdoutIsTTY: true, ask: async () => "wrong" };
  const noPrompt = async () => assert.fail("The gate must not prompt before it checks CI and both TTYs");
  for (const [patch, error] of [
    [{ env: { CI: "" } }, "ci"], [{ env: { GITHUB_ACTIONS: "false" } }, "ci"],
    [{ stdinIsTTY: false }, "no_tty"], [{ stdoutIsTTY: false }, "no_tty"],
  ] as const) assert.deepEqual(await liveGate({ ...terminal, ...patch, ask: noPrompt }), { ok: false, error });
  assert.deepEqual(await liveGate(terminal), { ok: false, error: "phrase_mismatch" });
});

it("TP-44: a correct cap phrase still gets the fixed D4 refusal", async () => {
  const lines: string[] = [];
  const code = await main(["--live", "--evidence-root", tmpdir()], {
    env: {}, stdinIsTTY: true, stdoutIsTTY: true,
    ask: async (prompt) => {
      assert.ok(prompt.includes(LIVE_PHRASE));
      return LIVE_PHRASE;
    },
    out: (line) => lines.push(line),
    dryRun: async () => assert.fail("Live refusal must not enter the exercise"),
  });
  assert.equal(code, 2);
  assert.deepEqual(lines, ['{"success":false,"code":"D4_values_required"}']);
});

it("TP-45: reserves bootstrap, generation, tokens and cancel before the send boundary", async () => {
  const ledger = createLedger();
  let sent = 0;
  const transport: typeof fetch = async () => {
    sent += 1;
    assert.equal(ledger.used.probe.load + ledger.used.probe.generate + ledger.used.session.generate, sent);
    return new Response(null);
  };
  const init = { method: "POST", body: "{}", redirect: "error" } as const;
  const make = (phase: "probe" | "session", output: number, thinking = 0, tools = false) =>
    cappedFetch(ledger, () => ({ phase, output, thinking, tools, deadline: performance.now() + 10_000 }), transport);
  const probe = make("probe", 21);
  await probe(BOOTSTRAP_URL, init);
  for (let i = 0; i < 3; i += 1) await probe(GENERATE_URL, init);
  assert.equal(ledger.used.probe.generate, 3);
  assert.equal(sent, 4);
  const session = make("session", 341, 170, true);
  for (let i = 0; i < 6; i += 1) await session(GENERATE_URL, init);
  assert.equal(sent, 10);
  assert.deepEqual(ledger.reserveCancel(), { ok: true, value: undefined });
  await assert.rejects(session(GENERATE_URL, init), { message: "cost_cap" });
  assert.deepEqual(ledger.reserveCancel(), { ok: false, error: "cost_cap" });
});

it("stops active and later calls after the first refused operation", async () => {
  const ledger = createLedger();
  const signals: AbortSignal[] = [];
  const send = cappedFetch(ledger, () => ({ phase: "probe", output: 1, thinking: 0, tools: false,
    deadline: performance.now() + 5000 }), async (_url, init) => {
    assert.ok(init?.signal);
    signals.push(init.signal);
    return new Response(null);
  });
  const init = { method: "POST", body: "{}" };
  await send(BOOTSTRAP_URL, init);
  await assert.rejects(send(BOOTSTRAP_URL.replace("loadCodeAssist", "onboardUser"), init), { message: "cost_cap" });
  await assert.rejects(send(GENERATE_URL, init), { message: "cost_cap" });
  assert.equal(signals.length, 1);
  assert.equal(signals[0]?.aborted, true);
});

it("refuses extra operations independently of the other caps", () => {
  const budget = { phase: "probe", output: 1, thinking: 0, tools: false, deadline: performance.now() + 5000 } as const;
  for (const kind of ["load", "generate"] as const) {
    const ledger = createLedger();
    for (let i = 0; i < (kind === "load" ? 1 : 3); i++) assert.ok(ledger.reserve(kind, budget).ok);
    assert.deepEqual(ledger.reserve(kind, budget), { ok: false, error: "cost_cap" });
  }
  const ledger = createLedger();
  assert.ok(ledger.reserveCancel().ok);
  assert.deepEqual(ledger.reserveCancel(), { ok: false, error: "cost_cap" });
});

it("TP-45: denies a bad counter, an expired deadline or excess tokens without a send", async () => {
  const base = { phase: "probe", output: 64, thinking: 0, tools: false, deadline: performance.now() + 5000 } as const;
  const init = { method: "POST", body: "{}", redirect: "error" } as const;
  for (const [budget, ledger, message] of [
    [base, createLedger({ ...emptyCounts(), probe: { ...emptyCounts().probe, generate: NaN } }), "broken_cap"],
    [{ ...base, deadline: performance.now() - 1 }, createLedger(), "cost_cap"],
    [{ ...base, tools: true }, createLedger(), "cost_cap"],
    [{ ...base, output: 65 }, createLedger(), "cost_cap"],
    [{ ...base, phase: "session", output: 2049 }, createLedger(), "cost_cap"],
    [{ ...base, phase: "session", thinking: 1025 }, createLedger(), "cost_cap"],
  ] as const) {
    const send = cappedFetch(ledger, () => budget, async () => assert.fail("A refused request must not reach the transport"));
    await assert.rejects(send(GENERATE_URL, init), { message });
  }
});

it("TP-45: caps total output and thinking tokens across sends", async () => {
  for (const [phase, output, thinking] of [["probe", 33, 0], ["session", 1025, 0], ["session", 1, 513]] as const) {
    const ledger = createLedger();
    let sent = 0;
    const send = cappedFetch(ledger, () => ({ phase, output, thinking, tools: false, deadline: performance.now() + 5000 }),
      async () => { sent += 1; return new Response(null); });
    const init = { method: "POST", body: "{}", redirect: "error" } as const;
    await send(GENERATE_URL, init);
    await assert.rejects(send(GENERATE_URL, init), { message: "cost_cap" });
    assert.equal(sent, 1);
  }
});

it("rejects a redirected reply before the byte counter can hide its origin", async () => {
  const ledger = createLedger();
  const redirected = Object.defineProperty(new Response("fixture"), "redirected", { value: true });
  const send = cappedFetch(ledger, () => ({ phase: "probe", output: 1, thinking: 0, tools: false,
    deadline: performance.now() + 5000 }), async () => redirected);
  await assert.rejects(send(BOOTSTRAP_URL, { method: "POST", body: "{}" }), { message: "broken_cap" });
  assert.equal(ledger.failure, "broken_cap");
});

it("TP-45: bounds the total probe reply bytes at 1 MiB", async () => {
  const ledger = createLedger();
  const send = cappedFetch(ledger,
    () => ({ phase: "probe", output: 1, thinking: 0, tools: false, deadline: performance.now() + 5000 }),
    async () => new Response(new Uint8Array(512 * 1024)));
  const init = { method: "POST", body: "{}", redirect: "error" } as const;
  for (const url of [BOOTSTRAP_URL, GENERATE_URL]) assert.equal((await (await send(url, init)).arrayBuffer()).byteLength, 512 * 1024);
  const response = await send(GENERATE_URL, init);
  await assert.rejects(response.arrayBuffer(), { message: "cost_cap" });
  assert.equal(ledger.failure, "cost_cap");
});

it("TP-46: accepts fixed evidence only", async () => {
  const report = { schemaVersion: 1, mode: "dry-run", success: true, code: null, counts: emptyCounts(),
    probeStatus: "2xx", actionRequests: 2, controlPublished: true, controlRemoved: true, cancelled: true };
  assert.equal(checkEvidence(report), true);
  for (const text of ["/fixture/record.json", "fixture@example.invalid", "Bearer fixture.value"])
    assert.equal(checkEvidence({ ...report, code: text }), false);
  assert.equal(checkEvidence({ ...report, counts: { ...report.counts, extra: "fixture" } }), false);
  assert.equal(checkEvidence({ ...report, probeStatus: "200 OK" }), false);
});
