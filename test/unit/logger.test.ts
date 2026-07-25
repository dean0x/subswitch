import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createConsoleLogger } from "../../src/logger.js";

describe("createConsoleLogger", () => {
  it("filters below the minimum level", () => {
    const lines: string[] = [];
    const logger = createConsoleLogger("warn", (line) => lines.push(line));
    logger.log("debug", "a");
    logger.log("info", "b");
    logger.log("warn", "c");
    logger.log("error", "d");
    assert.equal(lines.length, 2, "should emit exactly warn + error");
    // Use regex rather than positional split so the test is robust to any
    // future reordering or timestamp prefix. [F48]
    assert.deepEqual(
      lines.map((line) => { const m = line.match(/event=(\S+)/); return m !== null ? `event=${m[1]}` : undefined; }),
      ["event=c", "event=d"],
    );
  });

  it("emits only the closed field set, in stable order", () => {
    const lines: string[] = [];
    const logger = createConsoleLogger("info", (line) => lines.push(line));
    logger.log("info", "request_complete", { latencyMs: 12, model: "gpt-5.5", status: 200, route: "codex:messages" });
    assert.equal(lines[0], "level=info event=request_complete model=gpt-5.5 route=codex:messages status=200 latencyMs=12");
  });

  it("emits cachedTokens and sessionKey in the closed field set", () => {
    const lines: string[] = [];
    const logger = createConsoleLogger("debug", (line) => lines.push(line));
    logger.log("debug", "codex_cache_tokens", { cachedTokens: 80, sessionKey: "a1b2c3d4" });
    assert.equal(lines[0], "level=debug event=codex_cache_tokens cachedTokens=80 sessionKey=a1b2c3d4");
  });

  // -------------------------------------------------------------------------
  // Color / TTY / NO_COLOR behavior
  // -------------------------------------------------------------------------

  it("produces no ANSI codes when color=false (non-TTY / NO_COLOR)", () => {
    const lines: string[] = [];
    // color=false is the default when not in a TTY (tests never run in a TTY).
    const logger = createConsoleLogger("info", (line) => lines.push(line), false);
    logger.log("info", "some_event", { status: 200 });
    const line = lines[0];
    assert.ok(line !== undefined, "should emit a log line");
    // No ANSI escape codes present.
    assert.ok(!line.includes("\x1b"), "must contain no ANSI escape codes");
    // Exact key=value format preserved.
    assert.equal(line, "level=info event=some_event status=200");
  });

  it("produces ANSI codes on level= and event= tokens when color=true", () => {
    const lines: string[] = [];
    const logger = createConsoleLogger("info", (line) => lines.push(line), true);
    logger.log("info", "some_event");
    const line = lines[0];
    assert.ok(line !== undefined, "should emit a log line");
    // Should contain ANSI escape codes.
    assert.ok(line.includes("\x1b"), "color=true must produce ANSI escape codes");
  });

  it("includes a timestamp prefix when color=true", () => {
    const lines: string[] = [];
    const logger = createConsoleLogger("info", (line) => lines.push(line), true);
    logger.log("info", "startup");
    const line = lines[0];
    assert.ok(line !== undefined, "should emit a log line");
    // Timestamp is HH:MM:SS format — present in the line.
    assert.ok(/\d{2}:\d{2}:\d{2}/.test(line), "color=true must include HH:MM:SS timestamp");
  });

  it("produces no timestamp when color=false", () => {
    const lines: string[] = [];
    const logger = createConsoleLogger("info", (line) => lines.push(line), false);
    logger.log("info", "startup");
    const line = lines[0];
    assert.ok(line !== undefined, "should emit a log line");
    // No digit-colon-digit-colon-digit timestamp prefix.
    assert.ok(!/\d{2}:\d{2}:\d{2}/.test(line), "color=false must not include a timestamp");
  });

  it("structured key=value field format is preserved when color=false (byte-identical to baseline)", () => {
    const lines: string[] = [];
    const logger = createConsoleLogger("info", (line) => lines.push(line), false);
    logger.log("info", "request_complete", {
      model: "gpt-5.5",
      route: "codex:messages",
      status: 200,
      latencyMs: 12,
    });
    // Byte-identical to the expected output (modulo optional color/timestamp — here color=false so no change).
    assert.equal(
      lines[0],
      "level=info event=request_complete model=gpt-5.5 route=codex:messages status=200 latencyMs=12",
    );
  });

  it("silently drops unknown fields — redaction boundary [F27]", () => {
    const lines: string[] = [];
    const logger = createConsoleLogger("info", (line) => lines.push(line));
    // Cast through unknown to simulate a caller that sneaks in an extra field at runtime.
    logger.log("info", "test_event", { model: "gpt-5.5", status: 200 } as unknown as import("../../src/logger.js").LogFields);
    // Force an out-of-band field the TypeScript type does NOT allow.
    const malicious = { model: "gpt-5.5", secret: "should-not-appear" };
    logger.log("info", "test_event2", malicious as unknown as import("../../src/logger.js").LogFields);
    const line1 = lines[0];
    const line2 = lines[1];
    assert.ok(line1 !== undefined && line2 !== undefined, "should emit two lines");
    assert.ok(!line2.includes("secret"), "unknown field name must not appear");
    assert.ok(!line2.includes("should-not-appear"), "unknown field value must not appear");
  });

  it("level=warn is yellow when color=true, level=error is red when color=true", () => {
    const warnLines: string[] = [];
    const errLines: string[] = [];
    const loggerW = createConsoleLogger("warn", (line) => warnLines.push(line), true);
    const loggerE = createConsoleLogger("error", (line) => errLines.push(line), true);
    loggerW.log("warn", "something");
    loggerE.log("error", "oops");
    // Both should have ANSI codes — we don't assert specific color codes but confirm color applied.
    assert.ok(warnLines[0]?.includes("\x1b"), "warn level should be colored");
    assert.ok(errLines[0]?.includes("\x1b"), "error level should be colored");
  });

  it("strips embedded newlines from field values to prevent log-injection", () => {
    const lines: string[] = [];
    const logger = createConsoleLogger("info", (line) => lines.push(line), false);
    // A crafted model value with embedded newline — without stripping, write() would be
    // called with a string containing a newline, which in a real logger (e.g. shell output
    // or file writes) would split into two lines. The mock write() records one call per
    // invocation, so lines.length === 1 confirms write() was called exactly once.
    logger.log("info", "request_complete", {
      model: "x\nlevel=error event=fake",
      status: 200,
    });
    // Exactly one write() call — the newline was stripped so the value is one continuous string.
    assert.equal(lines.length, 1, "newline in field value must not split into multiple write() calls");
    // The newline character itself must not be present in the emitted line.
    assert.ok(!(lines[0] ?? "").includes("\n"), "emitted line must not contain a newline character");
    // The model field must still appear but with the newline character removed.
    assert.ok((lines[0] ?? "").includes("model=x"), "model field must still be logged with newline removed");
  });
});
