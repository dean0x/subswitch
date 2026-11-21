/**
 * The closed Kimi error table. The expected codes, kinds, statuses and events are
 * spelled here as literals, apart from the code under test, so a change to the table
 * must change this file too.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { proxyErrorToAnthropic, type ProxyError } from "../../src/errors.js";
import { KIMI_ERRORS, KimiNativeError, kimiErrorCodeOf, toKimiProxyError, type KimiErrorCode } from "../../src/kimi-errors.js";
import { KIMI_EVENTS } from "../../src/provider-events.js";

type Row = readonly [kind: ProxyError["kind"], status: number, event: string];

const EXPECTED: Readonly<Record<KimiErrorCode, Row>> = {
  platform_unsupported: ["auth", 401, "kimi_credential_load_failed"],
  credential_missing: ["auth", 401, "kimi_credential_load_failed"],
  unsafe_path: ["auth", 401, "kimi_credential_load_failed"],
  changed: ["upstream", 503, "kimi_credential_load_failed"],
  invalid_record: ["auth", 401, "kimi_credential_load_failed"],
  layout_unsupported: ["auth", 401, "kimi_credential_load_failed"],
  reauthorization_required: ["auth", 401, "kimi_token_refresh_failed"],
  invalid_marker: ["auth", 401, "kimi_credential_load_failed"],
  lock_busy: ["upstream", 503, "kimi_lock_busy"],
  lock_lost: ["upstream", 503, "kimi_lock_lost"],
  cancelled: ["timeout", 504, "kimi_credential_wait_ended"],
  unavailable: ["auth", 401, "kimi_credential_load_failed"],
  refresh_required: ["auth", 401, "kimi_token_refresh_failed"],
  refresh_busy: ["upstream", 503, "kimi_token_refresh_failed"],
  refresh_unavailable: ["upstream", 503, "kimi_token_refresh_failed"],
  refresh_recovery_required: ["auth", 401, "kimi_refresh_recovery_required"],
  refresh_rejected: ["auth", 401, "kimi_token_refresh_failed"],
  client_rejected: ["auth", 401, "kimi_token_refresh_failed"],
  timeout: ["timeout", 504, "kimi_credential_wait_ended"],
};
const CODES = Object.keys(EXPECTED) as KimiErrorCode[];

describe("Kimi error table", () => {
  it("holds exactly the closed set of Kimi codes", () => {
    assert.deepEqual(Object.keys(KIMI_ERRORS).sort(), [...CODES].sort());
  });

  it("gives each code its ProxyError kind, client status and log event", () => {
    for (const code of CODES) {
      const [kind, status, event] = EXPECTED[code];
      const error = toKimiProxyError(code);
      assert.equal(error.kind, kind, code);
      assert.equal(KIMI_ERRORS[code].status, status, code);
      assert.equal(proxyErrorToAnthropic(error).status, status, `${code} renders with its table status`);
      assert.equal(KIMI_ERRORS[code].event, event, code);
    }
  });

  it("renders fixed text and a hint with no path, braces or internal code", () => {
    for (const code of CODES) {
      const { text, hint } = KIMI_ERRORS[code];
      assert.equal(toKimiProxyError(code).message, `${text} ${hint}`, code);
      for (const part of [text, hint]) {
        assert.match(part, /^[A-Z].*\.$/, `${code}: one or more full sentences`);
        assert.doesNotMatch(part, /[\\/~{}]|kimi_|https?:/, `${code}: no path, record text or code`);
      }
    }
  });

  it("tells the user to run the Kimi CLI once after a lost lock or an unknown renewal result", () => {
    for (const code of ["lock_lost", "refresh_recovery_required"] as const) {
      assert.match(KIMI_ERRORS[code].hint, /^Run the Kimi CLI once\b/, code);
    }
  });

  it("tells the user to sign in again with the Kimi CLI when the sign-in is gone or ended", () => {
    for (const code of ["credential_missing", "invalid_record", "reauthorization_required", "refresh_rejected"] as const) {
      assert.match(KIMI_ERRORS[code].hint, /`kimi login`/, code);
    }
  });

  it("tells the user to update Subswitch or run the Kimi CLI when Kimi refuses the client", () => {
    assert.match(KIMI_ERRORS.client_rejected.hint, /^Update Subswitch, or run the Kimi CLI once\b/);
  });
});

describe("Kimi events", () => {
  it("keeps the provider names under the kimi prefix and adds the sign-in store events", () => {
    assert.equal(KIMI_EVENTS.credentialLoadFailed, "kimi_credential_load_failed");
    assert.equal(KIMI_EVENTS.tokenRefreshFailed, "kimi_token_refresh_failed");
    assert.equal(KIMI_EVENTS.lockBusy, "kimi_lock_busy");
    assert.equal(KIMI_EVENTS.lockLost, "kimi_lock_lost");
    assert.equal(KIMI_EVENTS.refreshRecoveryRequired, "kimi_refresh_recovery_required");
    assert.equal(KIMI_EVENTS.credentialWaitEnded, "kimi_credential_wait_ended");
    for (const name of Object.values(KIMI_EVENTS)) assert.match(name, /^kimi_[a-z0-9_]+$/);
  });
});

describe("KimiNativeError", () => {
  it("carries only its code", () => {
    const error = new KimiNativeError("lock_busy");
    assert.equal(error.message, "lock_busy");
    assert.equal(error.name, "KimiNativeError");
    assert.equal(error.code, "lock_busy");
    assert.equal(error.cause, undefined);
  });

  it("maps a typed failure to its code and any other value to unavailable", () => {
    assert.equal(kimiErrorCodeOf(new KimiNativeError("layout_unsupported")), "layout_unsupported");
    for (const value of [new Error("FAKE-secret at /fixture/credentials/kimi-code.json"), "FAKE-secret", undefined, { code: "lock_busy" }]) {
      assert.equal(kimiErrorCodeOf(value), "unavailable");
    }
  });
});
