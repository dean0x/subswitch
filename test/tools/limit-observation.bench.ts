/** Synthetic normal streams: observation must scale linearly without writing records. */
import { performance } from "node:perf_hooks";
import { LimitSseObserver } from "../../src/limit-http-observer.js";
import { LimitWebSocketObserver } from "../../src/limit-websocket-observer.js";
import type { Logger } from "../../src/logger.js";
const data = JSON.stringify({
  type: "response.output_text.delta",
  delta: "synthetic".repeat(24),
});
const sse = Buffer.from(
  "event: response.output_text.delta\ndata: " + data + "\n\n",
);
const json = Buffer.from(data),
  header = Buffer.alloc(4);
header[0] = 129;
header[1] = 126;
header.writeUInt16BE(json.length, 2);
const ws = Buffer.concat([header, json]);
const context = {
  provider: "codex",
  product: "chatgpt-codex",
  protocol: "responses",
} as const;
let records = 0;
const logger: Logger = {
  log() {},
  recordLimit() {
    records++;
  },
};
const median = (values: number[]) =>
  values.sort((a, b) => a - b)[Math.floor(values.length / 2)]!;
for (const [name, frame, create] of [
  ["SSE", sse, () => new LimitSseObserver(logger, context)],
  ["native WebSocket", ws, () => new LimitWebSocketObserver(logger, context)],
] as const) {
  let previous: number | undefined;
  for (const mib of [2, 4, 8]) {
    const bytes = Buffer.concat(
      Array.from(
        { length: Math.ceil((mib * 1024 * 1024) / frame.length) },
        () => frame,
      ),
    );
    const run = () => {
      const observer = create(),
        start = performance.now();
      for (let offset = 0; offset < bytes.length; offset += 8192)
        observer.write(bytes.subarray(offset, offset + 8192));
      return performance.now() - start;
    };
    run();
    const ms = median([run(), run(), run()]);
    console.log(
      name +
        " " +
        mib +
        "MiB median=" +
        ms.toFixed(1) +
        "ms" +
        (previous === undefined ? "" : " ratio=" + (ms / previous).toFixed(2)),
    );
    if (previous !== undefined && ms / previous > 3.5)
      throw new Error("nonlinear_limit_observation");
    previous = ms;
  }
}
if (records) throw new Error("normal_output_recorded");
console.log("Linearity passed; no normal output recorded.");
