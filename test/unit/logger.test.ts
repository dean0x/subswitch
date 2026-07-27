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
    // After stripping the newline, the value becomes "xlevel=error event=fake" — which
    // contains whitespace and '=', so it is quoted as "xlevel=error event=fake".
    // The field appears as: model="xlevel=error event=fake"
    assert.ok((lines[0] ?? "").includes('model="xlevel=error event=fake"'), "anomalous value must be quoted after newline is stripped");
  });

  // -------------------------------------------------------------------------
  // Event-token hardening.
  //
  // The `event` token is a SEPARATE axis from FIELD_KEYS: it is not a field, so the
  // closed allow-list does not cover it, and until this was fixed it was interpolated
  // into the output line raw while field values were stripped and quoted. Every event
  // name in the tree is a source literal, so the hole was not reachable — but event
  // names are now derived from the provider id, and a derivation is one edit away from
  // taking a config-supplied string. The type system is the primary control (the
  // derivation input is the closed ProviderId union); this is defence in depth.
  // -------------------------------------------------------------------------

  it("strips embedded newlines from the event token to prevent log-injection", () => {
    const lines: string[] = [];
    const logger = createConsoleLogger("info", (line) => lines.push(line), false);
    // A crafted event name carrying a complete forged record. Emitted raw, this splits
    // into two lines and the second one reads as a genuine error-level log entry.
    logger.log("info", "a\nlevel=error event=fake");
    assert.equal(lines.length, 1, "one log call must produce one write() call");
    const line = lines[0] ?? "";
    assert.ok(!line.includes("\n"), "emitted line must not contain a newline character");
    assert.ok(!line.includes("\r"), "emitted line must not contain a carriage return");
  });

  it("strips carriage returns from the event token — a lone \\r rewrites the line on a terminal", () => {
    const lines: string[] = [];
    const logger = createConsoleLogger("info", (line) => lines.push(line), false);
    logger.log("info", "a\rlevel=error event=fake");
    assert.ok(!(lines[0] ?? "").includes("\r"), "emitted line must not contain a carriage return");
  });

  it("quotes an event token containing whitespace or '=' so it cannot forge sibling fields", () => {
    const lines: string[] = [];
    const logger = createConsoleLogger("info", (line) => lines.push(line), false);
    logger.log("info", "real_event status=999", { status: 200 });
    const line = lines[0] ?? "";
    // The whole anomalous token is one quoted value, so a logfmt parser reads a single
    // `event` field rather than an `event` plus an injected `status`.
    assert.ok(line.includes('event="real_event status=999"'), `anomalous event token must be quoted; got: ${line}`);
    // The real status field must survive.
    assert.ok(line.endsWith(" status=200"), `real status field must remain; got: ${line}`);
    // Outside the quoted regions there is exactly one `status=` token — i.e. a parser that
    // honours quoting reads one status field, not the injected one plus the real one.
    // (Counting without stripping quotes would find both and prove nothing: quoting, not
    // deletion, is what defuses the injected token.)
    const unquoted = line.replace(/"[^"]*"/g, "");
    assert.equal(unquoted.match(/(?:^| )status=/g)?.length, 1, `exactly one top-level status token in: ${unquoted}`);
  });

  it("leaves an ordinary event name byte-identical — hardening must not reformat real logs", () => {
    const lines: string[] = [];
    const logger = createConsoleLogger("info", (line) => lines.push(line), false);
    logger.log("info", "codex_upstream_error", { model: "gpt-5.5", status: 502 });
    assert.equal(lines[0], "level=info event=codex_upstream_error model=gpt-5.5 status=502");
  });

  it("prevents field-forgery — values with whitespace or '=' are quoted so injected tokens cannot masquerade as real fields", () => {
    const lines: string[] = [];
    const logger = createConsoleLogger("info", (line) => lines.push(line), false);
    // An attacker crafts a model name that embeds a fake event= token.
    // Without quoting, a naive whitespace-splitting key=value parser with last-wins
    // semantics would read event=fake as the event field (overriding event=request_complete).
    logger.log("info", "request_complete", {
      model: "x event=fake",
      status: 200,
    });
    const line = lines[0] ?? "";
    // The anomalous value must be double-quoted so that the embedded token is not parseable
    // as a top-level field by a logfmt-aware parser.
    assert.ok(line.includes('model="x event=fake"'), "value with whitespace must be double-quoted to contain the injected token");
    // The bare string 'event=fake' must not appear as an unquoted top-level token.
    // Inside the quoted value it is safe; outside it would be parseable as a real field.
    assert.ok(!line.includes(" event=fake ") && !line.endsWith(" event=fake"),
      "bare unquoted 'event=fake' must not appear as a top-level token in the log line");
    // The real event token must remain.
    assert.ok(line.includes("event=request_complete"), "real event= token must be present");
  });
});
