import assert from "node:assert/strict";
import { test } from "node:test";
import { emptyCounts, parseArguments, reserveDispatch } from "../../e2e/gates/kimi-live-check.js";
import { KIMI_OAUTH_ORIGINS } from "../../src/kimi-auth.js";
import { kimiNativeTokenFilename } from "../../src/kimi-native-auth.js";

const store = `/private/kimi-home/credentials/${kimiNativeTokenFilename("global")}`;
const args = ["--kimi-auth-file", store, "--region", "global",
  "--evidence-dir", "/private/check/evidence", "--confirm-live"];
const local = "http://127.0.0.1:12345";
const kimi = "https://api.kimi.ai/coding/v1/messages?beta=true";
const claude = "https://api.anthropic.com/v1/messages";
const oauth = KIMI_OAUTH_ORIGINS.global + "/api/oauth/token";

test("accepts only the complete explicit live arguments", () => {
  assert.deepEqual(parseArguments(args), { kimiAuthFile: store, region: "global",
    evidenceDir: "/private/check/evidence" });
});
const withStore = (path: string) => args.map(s => s === store ? path : s);
for (const invalid of [args.slice(0, -1), [...args, "--extra"], [...args, "--confirm-live"],
  args.map(s => s === "global" ? "mainland-cn" : s), withStore(kimiNativeTokenFilename("global")),
  args.map(s => s === "/private/check/evidence" ? "/private/check/../evidence" : s),
  withStore("/private/check/auth.json"), withStore("/private/kimi-home/credentials/kimi-code.json"),
  withStore("/private/kimi-home/other/" + kimiNativeTokenFilename("global")),
  withStore(`/Users/test/.claude/credentials/${kimiNativeTokenFilename("global")}`),
  args.map(s => s === "/private/check/evidence" ? store : s)]) {
  test("refuses incomplete, duplicate, foreign, or non-native-store arguments", () => {
    assert.equal(parseArguments(invalid), undefined);
  });
}

test("counts each Kimi attempt and its requested cap without mutation", () => {
  const before = emptyCounts();
  const next = reserveDispatch(before, kimi, "POST", 256, local);
  assert.deepEqual(next, { counts: { calls: 1, kimi: 1, kimiTokens: 256, claude: 0, refresh: 0, loopback: 0 }, provider: "kimi" });
  assert.deepEqual(before, emptyCounts());
});
test("admits the last Kimi attempt at the total token limit", () => {
  assert.equal(reserveDispatch({ ...emptyCounts(), calls: 17, kimi: 17, kimiTokens: 4352 }, kimi, "POST", 256, local).counts.kimiTokens, 4608);
});
for (const state of [{ ...emptyCounts(), kimi: 18 }, { ...emptyCounts(), kimiTokens: 4608 }]) {
  test("refuses a Kimi attempt beyond either total limit", () => {
    assert.throws(() => reserveDispatch(state, kimi, "POST", 1, local));
  });
}
for (const cap of [257, 0, -1, 1.5, NaN, Infinity, undefined, "256"]) {
  test("refuses an invalid or excessive per-request cap", () => {
    assert.throws(() => reserveDispatch(emptyCounts(), claude, "POST", cap, local));
  });
}
test("admits eight Claude requests and refuses the ninth", () => {
  const next = reserveDispatch({ ...emptyCounts(), claude: 7 }, claude, "POST", 256, local);
  assert.equal(next.counts.claude, 8);
  assert.throws(() => reserveDispatch(next.counts, claude, "POST", 256, local));
});
test("admits one exact OAuth POST and refuses a second", () => {
  const next = reserveDispatch(emptyCounts(), oauth, "POST", undefined, local);
  assert.equal(next.provider, "refresh");
  assert.equal(next.counts.refresh, 1);
  assert.throws(() => reserveDispatch(next.counts, oauth, "POST", undefined, local));
});
for (const [url, method] of [[oauth, "GET"], [oauth + "?extra=1", "POST"], [oauth + "/", "POST"],
  ["https://auth.kimi.ai/other", "POST"], ["https://api.kimi.com/coding/v1/messages", "POST"],
  ["https://api.anthropic.com:444/v1/messages", "POST"], [claude, "GET"],
  ["https://api.anthropic.com/other", "POST"], ["https://user@api.anthropic.com/v1/messages", "POST"],
  ["http://api.anthropic.com/v1/messages", "POST"], ["https://example.invalid/", "POST"],
  ["http://127.0.0.1:54321/", "POST"]]) {
  test("refuses a foreign host, port, method, or path before dispatch", () => {
    assert.throws(() => reserveDispatch(emptyCounts(), url!, method!, 256, local));
  });
}
test("allows only this proxy loopback origin with a fixed call bound", () => {
  const next = reserveDispatch(emptyCounts(), local + "/__subswitch/actions", "POST", undefined, local);
  assert.equal(next.provider, "loopback");
  assert.equal(next.counts.loopback, 1);
  assert.throws(() => reserveDispatch({ ...emptyCounts(), loopback: 32 }, local + "/", "POST", undefined, local));
});
