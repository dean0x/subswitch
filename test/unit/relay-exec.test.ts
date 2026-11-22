import assert from "node:assert/strict";
import type { ExecFileException } from "node:child_process";
import { describe, it } from "node:test";
import { launchctlResult } from "../../src/relay-exec.js";

describe("launchctlResult", () => {
  it("returns zero on success", () => {
    assert.deepEqual(launchctlResult(null), { ok: true, value: 0 });
  });

  for (const code of [3, 113, 5]) {
    it(`preserves exit code ${code}`, () => {
      const error = Object.assign(new Error("launchctl exited"), { code });
      assert.deepEqual(launchctlResult(error), { ok: true, value: code });
    });
  }

  it("returns an error when the timeout kills launchctl", () => {
    const error: ExecFileException = Object.assign(new Error("launchctl timed out"), {
      code: null, killed: true, signal: "SIGKILL" as const,
    });
    assert.deepEqual(launchctlResult(error), { ok: false, error: "launchctl did not complete" });
  });

  it("returns an error when launchctl cannot start", () => {
    const error = Object.assign(new Error("launchctl not found"), { code: "ENOENT" });
    assert.deepEqual(launchctlResult(error), { ok: false, error: "launchctl did not complete" });
  });
});
