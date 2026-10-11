import { spawn } from "node:child_process";
import { basename } from "node:path";
import { randomUUID } from "node:crypto";
import { buildDeps, createProxyServer, listenServer } from "./server.js";
import type { Config } from "./config.js";
import { readActionControl } from "./routing/action-control.js";
import {
  RoutingError,
  type OriginatingClient,
} from "./routing/routing-types.js";

/** One process group is one explicit action; interactive prompts share that action. */
export async function runAction(
  config: Config,
  client: OriginatingClient,
  native: string[],
  conversationId: string = randomUUID(),
): Promise<number> {
  if (!native[0]) throw new RoutingError("native_command_required");
  const remote = await readActionControl(config.port);
  let local: ReturnType<typeof createProxyServer> | undefined;
  let router: import("./routing/shared-routing.js").SharedRouting | undefined;
  let port: number, capability: string;
  const control = async (path: string, body: unknown = {}) => {
    const response = await fetch(
      `http://127.0.0.1:${port}/__subswitch/actions${path}`,
      {
        method: "POST",
        redirect: "error",
        headers: {
          "content-type": "application/json",
          "x-subswitch-capability": capability,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(8000),
      },
    );
    if (!response.ok) {
      await response.body?.cancel();
      throw new RoutingError("action_control_rejected", response.status);
    }
    return response.json() as Promise<{ id: string; ingressPrefix: string }>;
  };
  let actionId: string | undefined,
    closed = false;
  const finish = async (cancel: boolean) => {
    if (!actionId || closed) return;
    await control(`/${actionId}/${cancel ? "cancel" : "complete"}`);
    closed = true;
  };
  try {
    if (remote) {
      port = remote.port;
      capability = remote.capability;
    } else {
      const deps = buildDeps({
        ...config,
        codexIngress: { ...config.codexIngress, enabled: true },
      });
      if (!deps.ok) throw new Error(deps.error);
      router = deps.value.sharedRouting!;
      local = createProxyServer(deps.value);
      const listening = await listenServer(local, 0, "127.0.0.1");
      if (!listening.ok) throw new Error("action_listener_failed");
      const address = local.address();
      if (!address || typeof address === "string")
        throw new Error("action_listener_failed");
      port = address.port;
      capability = router.actions.capability;
    }
    const action = await control("", { client, conversationId });
    if (
      !/^[a-f0-9-]{36}$/.test(action.id) ||
      action.ingressPrefix !== `/__subswitch/action/${action.id}/ingress`
    )
      throw new RoutingError("invalid_action_control_reply", 502);
    actionId = action.id;
    const base = `http://127.0.0.1:${port}${action.ingressPrefix}`;
    const env = { ...process.env };
    const args = native.slice(1);
    if (client === "claude-code") env["ANTHROPIC_BASE_URL"] = base;
    else {
      const codexBase = `${base}/codex/backend-api/codex`;
      env["OPENAI_BASE_URL"] = codexBase;
      if (/^codex(?:\.exe)?$/.test(basename(native[0])))
        args.unshift("-c", `openai_base_url=${JSON.stringify(codexBase)}`);
    }
    const group = process.platform !== "win32";
    const child = spawn(native[0], args, {
      env,
      stdio: "inherit",
      detached: group,
    });
    let cancelled = false;
    const kill = (signal: NodeJS.Signals) => {
      try {
        if (group && child.pid) process.kill(-child.pid, signal);
        else child.kill(signal);
      } catch {
        /* Already exited. */
      }
    };
    const cancel = () => {
      if (cancelled) return;
      cancelled = true;
      void finish(true).catch(() => undefined);
      kill("SIGTERM");
    };
    let force: ReturnType<typeof setTimeout> | undefined;
    const stop = () => {
      cancel();
      force = setTimeout(() => kill("SIGKILL"), 500).unref();
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    try {
      const code = await new Promise<number>((resolve, reject) => {
        child.once("error", reject);
        child.once("close", (c) => resolve(c ?? 130));
      });
      // The boundary ends after the native group; clear descendants before closing admission.
      if (group) kill("SIGKILL");
      await finish(cancelled || code !== 0);
      return code;
    } finally {
      clearTimeout(force);
      process.off("SIGINT", stop);
      process.off("SIGTERM", stop);
    }
  } finally {
    await finish(true).catch(() => undefined);
    router?.close();
    if (local)
      await new Promise<void>((resolve) => local!.close(() => resolve()));
  }
}
