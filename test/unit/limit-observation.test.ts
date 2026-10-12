/** Synthetic upstream contracts and injected diagnostic sinks; no inference. */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  mkdtemp,
  rm,
  stat,
  symlink,
  writeFile,
  readdir,
  mkdir,
  readFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  limitHeaders,
  recordLimitFailure,
  type LimitObservation,
  type LimitContext,
} from "../../src/limit-observation.js";
import { LimitSseObserver } from "../../src/limit-http-observer.js";
import {
  LimitRecorder,
  readLimitObservations,
} from "../../src/limit-recorder.js";
import { LimitWebSocketObserver } from "../../src/limit-websocket-observer.js";
import type { Logger } from "../../src/logger.js";
const context: LimitContext = {
  provider: "kimi",
  product: "kimi-code",
  protocol: "messages",
  profile: "private-account",
  route: "work",
  attempt: 0,
};
function sink() {
  const records: LimitObservation[] = [],
    warnings: string[] = [];
  const logger: Logger = {
    log: (_level, name) => {
      warnings.push(name);
    },
    recordLimit: (record) => {
      records.push(record);
    },
  };
  return { logger, records, warnings };
}
function failure(logger: Logger, text: string, status = 403) {
  recordLimitFailure(logger, context, {
    transport: "http",
    committed: false,
    status,
    text,
    headers: new Headers({
      "retry-after": "120",
      authorization: "private-value",
      "set-cookie": "private-value",
    }),
  });
}
const error = {
  type: "error",
  error: {
    code: "usage_limit_reached",
    status: 429,
    message: "private prompt echoed by vendor",
    resets_at: 1893456000,
  },
};
describe("private limit observations", () => {
  it("retains real error structure, public codes, numeric resets and validated headers without free text", () => {
    const { logger, records } = sink();
    failure(logger, JSON.stringify(error), 429);
    const encoded = JSON.stringify(records);
    assert.match(encoded, /usage_limit_reached/);
    assert.match(encoded, /1893456000/);
    assert.ok(!encoded.includes("private"));
    assert.equal(records[0]!.candidate, "limit");
    assert.deepEqual(records[0]!.headers, { "retry-after": "120" });
    assert.equal(records[0]!.committed, false);
  });
  it("keeps known Kimi limit prefixes without recording the vendor's free-form remainder", () => {
    const { logger, records } = sink();
    for (const message of [
      "You've reached your 5-hour usage limit.",
      "You've reached your weekly (7-day) usage limit.",
      "You've reached your monthly usage limit for this billing cycle.",
    ])
      failure(
        logger,
        JSON.stringify({
          error: { message: message + " private identity and prompt" },
        }),
      );
    assert.equal(records.length, 3);
    const encoded = JSON.stringify(records);
    assert.match(encoded, /weekly/);
    assert.match(encoded, /monthly/);
    assert.ok(!encoded.includes("private identity"));
  });
  it("records unknown formats as observations without exposing unknown strings or turning them into quota", () => {
    const { logger, records } = sink();
    failure(
      logger,
      JSON.stringify({
        unexpected: {
          secret_field_name: "prompt",
          code: "private_secret_code",
          message: "authorization secret",
          arbitraryNumber: 123456,
        },
      }),
    );
    assert.equal(records[0]!.candidate, "possible-limit");
    const encoded = JSON.stringify(records);
    for (const value of [
      "private_secret_code",
      "secret_field_name",
      "authorization secret",
      "123456",
    ])
      assert.ok(!encoded.includes(value));
    assert.match(encoded, /fingerprint/);
    assert.match(encoded, /unknown_field/);
  });
  it("bounds untrusted structures and discards non-JSON, truncated and encoded content", () => {
    const { logger, records } = sink();
    failure(logger, "<html>private error</html>");
    recordLimitFailure(logger, context, {
      transport: "http",
      committed: false,
      status: 429,
      text: '{"error":',
      truncated: true,
    });
    recordLimitFailure(logger, context, {
      transport: "http",
      committed: false,
      status: 429,
      encoded: true,
    });
    let deep: unknown = "private";
    for (let i = 0; i < 100; i++) deep = { error: deep };
    failure(logger, JSON.stringify(deep));
    assert.deepEqual(
      records.slice(0, 3).map((record) => record.bodyState),
      ["non-json", "truncated", "encoded"],
    );
    assert.ok(JSON.stringify(records).length < 4000);
    assert.ok(!JSON.stringify(records).includes("private"));
  });
  it("validates provider reset-header values and redacts header injection", () => {
    const headers = limitHeaders(
      new Headers({
        "x-ratelimit-reset-requests": "1m2s",
        "anthropic-ratelimit-unified-7d-reset": "1893456000",
        "anthropic-ratelimit-unified-5h-status": "rejected",
        "anthropic-ratelimit-requests-reset": "2030-01-01T00:00:00Z",
        "retry-after": "private-secret",
        "x-request-id": "private-id",
      }),
    );
    assert.equal(headers["x-ratelimit-reset-requests"], "1m2s");
    assert.equal(headers["anthropic-ratelimit-unified-5h-status"], "rejected");
    assert.equal(headers["retry-after"], "<redacted>");
    assert.ok(!JSON.stringify(headers).includes("private"));
  });
  it("contains throwing or absent diagnostic sinks", () => {
    failure(
      {
        log() {},
        recordLimit() {
          throw new Error("offline");
        },
      },
      JSON.stringify(error),
    );
    failure({ log() {} }, JSON.stringify(error));
  });
});
describe("passive streaming observations", () => {
  for (const transport of ["sse", "websocket"] as const) {
    it(`captures bounded ${transport} errors across more than 4096 tiny chunks`, () => {
      const { logger, records, warnings } = sink();
      const payload = Buffer.from(JSON.stringify({
        ...error,
        error: { ...error.error, message: "private ü".repeat(600) },
      }));
      assert.ok(payload.length > 4096 && payload.length < 64 * 1024);
      const header = Buffer.alloc(4);
      header[0] = 129;
      header[1] = 126;
      header.writeUInt16BE(payload.length, 2);
      const bytes = transport === "sse"
        ? Buffer.concat([Buffer.from("event: error\ndata: "), payload, Buffer.from("\n\n")])
        : Buffer.concat([header, payload]);
      const scanner = transport === "sse"
        ? new LimitSseObserver(logger, context)
        : new LimitWebSocketObserver(logger, context);
      for (let offset = 0; offset < bytes.length; offset++)
        scanner.write(bytes.subarray(offset, offset + 1));
      assert.equal(records.length, 1);
      assert.equal(records[0]!.bodyState, "json");
      assert.equal(records[0]!.status, 429);
      assert.deepEqual(warnings, []);
      assert.ok(!JSON.stringify(records).includes("private"));
    });
  }
  it("handles every single-byte CRLF boundary and skips successful assistant/tool output", () => {
    const { logger, records } = sink(),
      scanner = new LimitSseObserver(logger, context);
    const bytes = Buffer.from(
      'event: response.created\r\ndata: {"type":"response.created"}\r\n\r\n' +
        'event: response.output_text.delta\r\ndata: {"type":"response.output_text.delta","delta":"private ü"}\r\n\r\n' +
        "event: error\r\ndata: " +
        JSON.stringify(error) +
        "\r\n\r\n",
    );
    for (const byte of bytes) scanner.write(Buffer.from([byte]));
    assert.equal(records.length, 1);
    assert.equal(records[0]!.providerStartSeen, true);
    assert.equal(records[0]!.committed, "unknown");
    assert.ok(!JSON.stringify(records).includes("private"));
  });
  it("recovers after oversized normal SSE events and captures a subsequent failure", () => {
    const { logger, records } = sink(),
      scanner = new LimitSseObserver(logger, context);
    scanner.write(
      Buffer.from(
        "event: response.output_text.delta\ndata: " +
          "x".repeat(200000) +
          "\n\n",
      ),
    );
    scanner.write(
      Buffer.from("event: error\ndata: " + JSON.stringify(error) + "\n\n"),
    );
    assert.equal(records.length, 1);
    assert.equal(records[0]!.bodyState, "json");
  });
  it("captures data-only error events and marks oversized error events explicitly", () => {
    const { logger, records } = sink(),
      scanner = new LimitSseObserver(logger, context);
    scanner.write(Buffer.from("data: " + JSON.stringify(error) + "\n\n"));
    scanner.write(
      Buffer.from("event: error\ndata: " + "x".repeat(100000) + "\n\n"),
    );
    assert.equal(records.length, 2);
    assert.equal(records[1]!.bodyState, "truncated");
  });
  it("recognizes data-only starts and errors regardless of JSON property order", () => {
    for (const start of ["message_start", "response.created"]) {
      for (const type of ["error", "response.failed"]) {
        const { logger, records } = sink();
        const scanner = new LimitSseObserver(logger, context);
        const failure = {
          sequence_number: 1,
          type,
          ...(type === "error"
            ? { error: error.error }
            : { response: { error: error.error } }),
        };
        const bytes = Buffer.from(
          `data: ${JSON.stringify({ sequence_number: 0, type: start })}\r\n\r\n` +
          'data: {"delta":"private output","type":"response.output_text.delta"}\r\n\r\n' +
          `data: ${JSON.stringify(failure)}\r\n\r\n`,
        );
        for (const byte of bytes) scanner.write(Buffer.from([byte]));
        assert.equal(records.length, 1);
        assert.equal(records[0]!.providerStartSeen, true);
        assert.equal(records[0]!.status, 429);
        assert.equal(records[0]!.candidate, "limit");
        assert.equal(records[0]!.bodyState, "json");
        assert.ok(!JSON.stringify(records).includes("private"));
      }
    }
  });
  it("records unfamiliar error-event envelopes without inventing their type or coercing malformed status", () => {
    const { logger, records } = sink(),
      scanner = new LimitSseObserver(logger, context);
    scanner.write(
      Buffer.from(
        'event: error\ndata: {"error":{"status":{"valueOf":"private"},"code":"unknown_vendor_code"}}\n\n',
      ),
    );
    assert.equal(records.length, 1);
    assert.equal(records[0]!.status, undefined);
    assert.equal(records[0]!.bodyState, "json");
    assert.ok(!JSON.stringify(records[0]!.body).includes('"type"'));
    assert.ok(!JSON.stringify(records).includes("private"));
  });
  it("decodes fragmented native WebSocket text around ping frames without touching the tunnel", () => {
    const { logger, records } = sink(),
      scanner = new LimitWebSocketObserver(logger, context);
    const frame = (text: string, opcode: number, final: boolean) => {
      const bytes = Buffer.from(text);
      assert.ok(bytes.length < 126);
      return Buffer.concat([
        Buffer.from([(final ? 128 : 0) | opcode, bytes.length]),
        bytes,
      ]);
    };
    const text = JSON.stringify({
      type: "error",
      status: 429,
      error: { code: "usage_limit_reached" },
    });
    const bytes = Buffer.concat([
      frame(text.slice(0, 25), 1, false),
      frame("", 9, true),
      frame(text.slice(25), 0, true),
    ]);
    for (const byte of bytes) scanner.write(Buffer.from([byte]));
    assert.equal(records.length, 1);
    assert.equal(records[0]!.transport, "websocket");
    assert.equal(records[0]!.status, 429);
  });
  it("handles extended lengths, skips huge native frames, then captures the next error", () => {
    const { logger, records } = sink(),
      scanner = new LimitWebSocketObserver(logger, context);
    const huge = Buffer.alloc(70000, 120),
      header = Buffer.alloc(10);
    header[0] = 129;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(huge.length), 2);
    scanner.write(Buffer.concat([header, huge]));
    const body = Buffer.from(
      JSON.stringify({
        type: "error",
        status: 429,
        error: { code: "rate_limit_error" },
      }),
    );
    const small = Buffer.alloc(4);
    small[0] = 129;
    small[1] = 126;
    small.writeUInt16BE(body.length, 2);
    scanner.write(Buffer.concat([small, body]));
    assert.equal(records.length, 1);
  });
  it("reports compressed native-frame coverage gaps without decoding or logging its payload", () => {
    const { logger, records, warnings } = sink(),
      scanner = new LimitWebSocketObserver(logger, context);
    scanner.write(Buffer.from([193, 3, 1, 2, 3]));
    assert.equal(records.length, 0);
    assert.deepEqual(warnings, ["limit_observation_partial"]);
  });
});
describe("private bounded limit recorder", () => {
  it("persists sanitized records with owner-only permissions and reads them after restart", async () => {
    const dir = await mkdtemp(join(tmpdir(), "subswitch-limits-"));
    try {
      const { logger, records } = sink();
      failure(logger, JSON.stringify(error));
      const recorder = new LimitRecorder(join(dir, "private"), logger);
      recorder.record(records[0]!);
      await recorder.flush();
      assert.equal((await stat(join(dir, "private"))).mode & 0o777, 0o700);
      assert.equal(
        (await stat(join(dir, "private", "events.jsonl"))).mode & 0o777,
        0o600,
      );
      assert.deepEqual(
        await readLimitObservations(join(dir, "private")),
        JSON.parse(JSON.stringify(records)),
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
  it("rejects symlink destinations and contains filesystem errors", async () => {
    const dir = await mkdtemp(join(tmpdir(), "subswitch-limits-"));
    try {
      const { logger, records, warnings } = sink();
      failure(logger, JSON.stringify(error));
      const target = join(dir, "target");
      await writeFile(target, "do not modify", { mode: 0o600 });
      const privateDir = join(dir, "private");
      await mkdir(privateDir, { mode: 0o700 });
      await symlink(target, join(privateDir, "events.jsonl"));
      const recorder = new LimitRecorder(privateDir, logger);
      recorder.record(records[0]!);
      await recorder.flush();
      assert.equal(await readFile(target, "utf8"), "do not modify");
      assert.deepEqual(warnings, ["limit_recording_unavailable"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
  it("bounds pending work and rotates storage at eight MiB", async () => {
    const dir = await mkdtemp(join(tmpdir(), "subswitch-limits-"));
    try {
      const { logger, records, warnings } = sink();
      failure(logger, JSON.stringify(error));
      const recorder = new LimitRecorder(join(dir, "private"), logger);
      const large = {
        ...records[0]!,
        body: { message: "<string>".repeat(1500) },
      };
      for (let batch = 0; batch < 24; batch++) {
        for (let index = 0; index < 32; index++) recorder.record(large);
        await recorder.flush();
      }
      const paths = await readdir(join(dir, "private"));
      assert.ok(paths.length <= 4);
      const sizes = await Promise.all(
        paths.map((path) => stat(join(dir, "private", path))),
      );
      assert.ok(
        sizes.reduce((sum, entry) => sum + entry.size, 0) <= 8 * 1024 * 1024,
      );
      assert.ok(paths.includes("events.3.jsonl"));
      for (let index = 0; index < 100; index++) recorder.record(records[0]!);
      await recorder.flush();
      assert.ok(warnings.includes("limit_recording_dropped"));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
