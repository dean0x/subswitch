import type { IncomingMessage } from "node:http";
import type { ProviderAuth } from "./provider-auth.js";
import type { CodexEndpointMode } from "./codex-ingress.js";
import { ClaudeHttpError } from "./claude-errors.js";
import { abortable } from "./abortable.js";

const NATIVE_ENDPOINTS = new Set(["/responses", "/responses/compact", "/models"]);

/** Operator credentials are available only on exact native endpoint paths. */
export class CodexNativeAuth {
  constructor(private readonly auth?: ProviderAuth<"codex">,
    private readonly requestSignal?: (req: IncomingMessage) => AbortSignal | undefined) {}
  canRefresh(req: IncomingMessage, mode: CodexEndpointMode, path: string): boolean {
    return (
      mode === "subscription" &&
      NATIVE_ENDPOINTS.has(path.split("?")[0] ?? "") &&
      req.headers.authorization === undefined &&
      typeof req.headers["chatgpt-account-id"] === "string" &&
      this.auth !== undefined
    );
  }
  async headers(
    req: IncomingMessage,
    mode: CodexEndpointMode,
    path: string,
    refresh = false,
  ): Promise<readonly string[]> {
    const signal = this.requestSignal?.(req);
    signal?.throwIfAborted();
    if (!this.canRefresh(req, mode, path) || !this.auth) return req.rawHeaders;
    const pending = refresh ? this.auth.forceRefresh() : this.auth.getCredentials();
    const credentials = await (signal ? abortable(pending, signal) : pending);
    signal?.throwIfAborted();
    if (!credentials.ok) throw new ClaudeHttpError(401, credentials.error.message, "codex_auth_unavailable");
    const headers = credentials.value.authHeaders;
    if (headers["chatgpt-account-id"] !== req.headers["chatgpt-account-id"] || !headers["authorization"]) {
      throw new ClaudeHttpError(
        401,
        "Native Codex account does not match the configured Codex credential store.",
        "codex_account_mismatch",
      );
    }
    return [...req.rawHeaders, "authorization", headers["authorization"]];
  }
}
