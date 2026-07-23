import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { probeSubswitch, probeTlsReachable, type HttpGetResult, type TlsStatus } from "../../src/doctor.js";

describe("probeSubswitch", () => {
  it("returns running when the health endpoint responds with the subswitch shape", async () => {
    const httpGet = async (): Promise<HttpGetResult> => ({
      ok: true,
      status: 200,
      body: JSON.stringify({ name: "subswitch", version: "0.1.0" }),
    });
    const result = await probeSubswitch(4141, { httpGet });
    assert.equal(result.kind, "running");
    if (result.kind === "running") {
      assert.equal(result.name, "subswitch");
      assert.equal(result.version, "0.1.0");
    }
  });

  it("returns connection_refused when nothing is listening on the port", async () => {
    const httpGet = async (): Promise<HttpGetResult> => ({ ok: false, connectionRefused: true });
    const result = await probeSubswitch(4141, { httpGet });
    assert.equal(result.kind, "connection_refused");
  });

  it("returns not_subswitch when a different service responds with a non-subswitch body", async () => {
    const httpGet = async (): Promise<HttpGetResult> => ({
      ok: true,
      status: 200,
      body: JSON.stringify({ name: "nginx", version: "1.0.0" }),
    });
    const result = await probeSubswitch(4141, { httpGet });
    assert.equal(result.kind, "not_subswitch");
  });

  it("returns not_subswitch when the response is non-200", async () => {
    const httpGet = async (): Promise<HttpGetResult> => ({
      ok: true,
      status: 404,
      body: "{}",
    });
    const result = await probeSubswitch(4141, { httpGet });
    assert.equal(result.kind, "not_subswitch");
  });

  it("returns not_subswitch when the response body is not JSON", async () => {
    const httpGet = async (): Promise<HttpGetResult> => ({
      ok: true,
      status: 200,
      body: "not json at all",
    });
    const result = await probeSubswitch(4141, { httpGet });
    assert.equal(result.kind, "not_subswitch");
  });

  it("returns not_subswitch on non-connection-refused network errors", async () => {
    const httpGet = async (): Promise<HttpGetResult> => ({
      ok: false,
      connectionRefused: false,
      message: "timeout",
    });
    const result = await probeSubswitch(4141, { httpGet });
    assert.equal(result.kind, "not_subswitch");
  });

  it("uses the correct URL based on the port argument", async () => {
    let capturedUrl = "";
    const httpGet = async (url: string): Promise<HttpGetResult> => {
      capturedUrl = url;
      return { ok: false, connectionRefused: true };
    };
    await probeSubswitch(9999, { httpGet });
    assert.equal(capturedUrl, "http://127.0.0.1:9999/__subswitch/health");
  });
});

describe("probeTlsReachable", () => {
  it("returns reachable when the TLS connect succeeds", async () => {
    const tlsConnect = async (): Promise<TlsStatus> => ({ kind: "reachable" });
    const result = await probeTlsReachable("api.anthropic.com", { tlsConnect });
    assert.equal(result.kind, "reachable");
  });

  it("returns unreachable when the TLS connect fails", async () => {
    const tlsConnect = async (): Promise<TlsStatus> => ({
      kind: "unreachable",
      message: "ECONNREFUSED",
    });
    const result = await probeTlsReachable("api.anthropic.com", { tlsConnect });
    assert.equal(result.kind, "unreachable");
    if (result.kind === "unreachable") {
      assert.equal(result.message, "ECONNREFUSED");
    }
  });

  it("passes the host and port 443 to the tlsConnect dep", async () => {
    let capturedHost = "";
    let capturedPort = 0;
    const tlsConnect = async (host: string, port: number): Promise<TlsStatus> => {
      capturedHost = host;
      capturedPort = port;
      return { kind: "reachable" };
    };
    await probeTlsReachable("chatgpt.com", { tlsConnect });
    assert.equal(capturedHost, "chatgpt.com");
    assert.equal(capturedPort, 443);
  });
});
