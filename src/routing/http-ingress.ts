import type { IncomingMessage, ServerResponse } from "node:http";
import { aggregateFrames } from "../codex-response.js";
import { createFrameWriter, respondJson } from "../provider-transport.js";
import {
  openaiErrorBody,
  openaiFailureEvent,
  toAnthropicErrorBody,
  toAnthropicErrorSse,
  SYNTHESIZED_HEADER,
  SYNTHESIZED_MARKER,
} from "../errors.js";
import type { Logger } from "../logger.js";
import type { RoutingClock } from "./clock.js";
import { AttemptFailure } from "./attempt-failure.js";
import {
  RoutingError,
  type ActionContext,
  type Item,
  type OriginatingClient,
  type WireProtocol,
} from "./routing-types.js";

interface RoutedDispatch {
  events(
    body: Item,
    client: OriginatingClient,
    route: string,
    signal: AbortSignal,
    context?: ActionContext,
  ): AsyncIterable<Item>;
  context(
    req: IncomingMessage,
    client: OriginatingClient,
    body: Item,
  ): ActionContext | undefined;
}
const terminal = (event: Item) =>
  ["response.completed", "response.incomplete", "message_stop"].includes(
    String(event["type"]),
  );
const frame = (protocol: WireProtocol, event: Item) =>
  `${protocol === "messages" ? `event: ${event["type"]}\n` : ""}data: ${JSON.stringify(event)}\n\n`;

/** Owns HTTP response commitment and drain-based downstream backpressure. */
export async function writeRoutedHttp(
  dispatch: RoutedDispatch,
  logger: Logger,
  clock: RoutingClock,
  req: IncomingMessage,
  res: ServerResponse,
  body: Item,
  client: OriginatingClient,
  route: string,
): Promise<void> {
  const controller = new AbortController(),
    protocol = client === "codex" ? "responses" : "messages";
  const close = () => {
    if (!res.writableFinished) controller.abort();
  };
  res.on("close", close);
  const writer = createFrameWriter(res, controller.signal),
    frames: string[] = [];
  let result: unknown,
    bytes = 0;
  try {
    for await (const event of dispatch.events(
      { ...body, stream: body["stream"] === true },
      client,
      route,
      controller.signal,
      dispatch.context(req, client, body),
    )) {
      if (body["stream"] === true) {
        if (!res.headersSent)
          res.writeHead(200, {
            "content-type": "text/event-stream",
            "cache-control": "no-cache",
            [SYNTHESIZED_HEADER]: SYNTHESIZED_MARKER,
          });
        await writer(frame(protocol, event));
      } else {
        bytes += Buffer.byteLength(JSON.stringify(event));
        if (bytes > 64 * 1024 * 1024)
          throw new RoutingError("response_aggregate_too_large", 502);
        if (protocol === "messages") frames.push(frame(protocol, event));
        if (terminal(event)) result = event["response"];
      }
    }
    if (body["stream"] !== true) {
      if (protocol === "messages") {
        const aggregate = aggregateFrames(frames, "codex");
        if (!aggregate.ok || aggregate.value.kind !== "message")
          throw new RoutingError("invalid_provider_terminal", 502);
        result = aggregate.value.message;
      }
      if (!result) throw new RoutingError("missing_provider_terminal", 502);
      respondJson(res, 200, JSON.stringify(result));
    } else res.end();
  } catch (error) {
    writeRoutingError(res, protocol, error, logger, clock);
  } finally {
    res.off("close", close);
  }
}

export function writeRoutingError(
  res: ServerResponse,
  protocol: WireProtocol,
  error: unknown,
  logger: Logger,
  clock: RoutingClock,
): void {
  if (res.destroyed || res.writableEnded) return;
  const classified = error instanceof AttemptFailure ? error : undefined;
  const failure = classified?.failure;
  const code =
    error instanceof RoutingError
      ? error.code
      : classified
        ? classified.clientCode
        : "route_protocol_failure";
  const status =
    error instanceof RoutingError
      ? error.status
      : classified
        ? classified.clientStatus
        : 502;
  logger.log("warn", "route_request_failed", { status, errorCode: code });
  if (res.headersSent)
    res.end(
      protocol === "messages"
        ? toAnthropicErrorSse("api_error", code)
        : `data: ${JSON.stringify(openaiFailureEvent(code, code, { id: "", model: "", sequence: 0 }))}\n\n`,
    );
  else
    respondJson(
      res,
      status,
      protocol === "messages"
        ? toAnthropicErrorBody(
            failure?.kind === "quota" || failure?.kind === "rate_limit"
              ? "rate_limit_error"
              : failure?.kind === "permission"
                ? "permission_error"
                : failure?.kind === "auth"
                  ? "authentication_error"
                  : failure?.kind === "invalid_request"
                    ? "invalid_request_error"
                    : "api_error",
            code,
          )
        : openaiErrorBody(code, code),
      failure?.retryAt
        ? {
            "retry-after": String(
              Math.max(0, Math.ceil((failure.retryAt - clock.now()) / 1000)),
            ),
          }
        : {},
    );
}
