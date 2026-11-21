import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { TestContext } from "node:test";
import { GEMINI_DEFAULT_HOST } from "../../src/gemini-constants.js";
import { createKeychainReader } from "../../src/keychain-read.js";
import { startFakeUpstream, type UpstreamHandler } from "../integration/fake-upstreams.js";

export const GEMINI_TEST_MODEL = "gemini:fixture-gemini";
export const geminiTestProvider = { aliases: { "fixture-gemini": "fixture-target" } };
export const BOOTSTRAP = "/v1internal:loadCodeAssist";
export const GENERATE = "/v1internal:streamGenerateContent?alt=sse";
const origin = `https://${GEMINI_DEFAULT_HOST}`;
const project = "fixture-project";

// These are synthetic wire fields for the offline codec, not verified Google fields.
export const geminiData = (frame: unknown): string => `data: ${JSON.stringify(frame)}\n\n`;
export const geminiCandidate = (parts: readonly unknown[], finishReason?: "STOP"): string =>
  geminiData({ response: { candidates: [{ content: { parts }, finishReason }] } });

export const startGeminiFake = async (t: TestContext, handle: UpstreamHandler, bootstrap?: UpstreamHandler) => {
  const upstream = await startFakeUpstream((req, res, body, index) => {
    if (req.url !== BOOTSTRAP) return handle(req, res, body, index);
    if (bootstrap !== undefined) return bootstrap(req, res, body, index);
    res.end(JSON.stringify({ fixtureProject: project }));
  });
  t.after(upstream.close);
  const access = `fixture-access-${randomUUID()}`;
  const refresh = `fixture-refresh-${randomUUID()}`;
  const record = { token: { access_token: access, refresh_token: refresh, expiry: "2099-01-01T00:00:00Z" } };
  const execs: string[] = [];
  const fetches: { url: string; redirect: RequestInit["redirect"] }[] = [];
  const reader = createKeychainReader({
    platform: "darwin", env: {}, loginKeychainPath: "/fixture/login.keychain-db", setTimer: () => () => {},
    exec: async (_file, args) => {
      const secret = args.includes("-w");
      execs.push(secret ? "readSecret" : "probe");
      return { stdout: secret ? `go-keyring-base64:${Buffer.from(JSON.stringify(record)).toString("base64")}`
        : '"mdat"<timedate>=0x32303234303232393132333435365A00  "20240229123456Z\\000"' };
    },
  });
  const mapFetch: typeof fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    fetches.push({ url: url.pathname + url.search, redirect: init?.redirect });
    assert.equal(url.origin, origin);
    return fetch(upstream.url + url.pathname + url.search, init);
  };
  const extractProjectId = (value: unknown): string | undefined =>
    typeof value === "object" && value !== null && "fixtureProject" in value && value.fixtureProject === project
      ? project : undefined;
  return { upstream, execs, fetches, access, refresh, deps: { reader, fetch: mapFetch, extractProjectId } };
};
