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
});
