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
    assert.deepEqual(
      lines.map((line) => line.split(" ")[1]),
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
});
