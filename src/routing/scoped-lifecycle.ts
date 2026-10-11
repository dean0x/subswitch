import type { IncomingMessage, ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import { ActionStore } from "./action-store.js";
import { RoutingError, type ActionContext } from "./routing-types.js";

/** A scoped socket is transport ownership, not an indefinitely active inference. */
export class ScopedSocket {
  private readonly controller = new AbortController();
  private readonly admissions = new Set<() => void>();
  readonly signal = this.controller.signal;
  constructor(
    private readonly store: ActionStore,
    private readonly context: ActionContext,
    socket: Duplex,
  ) {
    const close = () => {
      this.controller.abort(new RoutingError("action_transport_closed", 499));
      socket.destroy();
    };
    const detach = store.attachTransport(context, close);
    socket.once("close", () => {
      close();
      detach();
      for (const release of this.admissions) release();
    });
  }
  check(): void {
    this.signal.throwIfAborted();
    this.store.context(this.context.actionId, this.context.client);
  }
  admit(): () => void {
    this.check();
    const controller = new AbortController();
    const cancel = () => this.controller.abort(controller.signal.reason);
    const release = this.store.admit(this.context, controller);
    controller.signal.addEventListener("abort", cancel, { once: true });
    let released = false;
    const finish = () => {
      if (released) return;
      released = true;
      controller.signal.removeEventListener("abort", cancel);
      this.admissions.delete(finish);
      release();
    };
    this.admissions.add(finish);
    return finish;
  }
}

/** HTTP admission ends with delivery; cancellation tears down native IO and auth waiting. */
export class ScopedLifecycle {
  private readonly http = new WeakMap<
    IncomingMessage,
    { signal: AbortSignal; context: ActionContext }
  >();
  private readonly sockets = new WeakMap<IncomingMessage, ScopedSocket>();
  constructor(private readonly store: ActionStore) {}
  signal(req: IncomingMessage): AbortSignal | undefined {
    return this.http.get(req)?.signal ?? this.sockets.get(req)?.signal;
  }
  admittedContext(req: IncomingMessage): ActionContext | undefined {
    const admission = this.http.get(req);
    if (!admission) return undefined;
    admission.signal.throwIfAborted();
    return { ...admission.context };
  }
  admitHttp(
    req: IncomingMessage,
    res: ServerResponse,
    context: ActionContext,
  ): AbortSignal {
    const existing = this.http.get(req);
    if (existing) return existing.signal;
    const controller = new AbortController(),
      release = this.store.admit(context, controller);
    this.http.set(req, { signal: controller.signal, context: { ...context } });
    const cancel = () => {
      res.destroy();
    };
    controller.signal.addEventListener("abort", cancel, { once: true });
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      res.off("finish", finish);
      res.off("close", finish);
      controller.signal.removeEventListener("abort", cancel);
      controller.abort(new RoutingError("request_finished", 499));
      release();
    };
    res.once("finish", finish);
    res.once("close", finish);
    return controller.signal;
  }
  socket(
    req: IncomingMessage,
    socket: Duplex,
    context: ActionContext,
  ): ScopedSocket {
    const existing = this.sockets.get(req);
    if (existing) return existing;
    const scoped = new ScopedSocket(this.store, context, socket);
    this.sockets.set(req, scoped);
    return scoped;
  }
}
