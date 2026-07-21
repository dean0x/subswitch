export type ProxyError =
  | { readonly kind: "auth"; readonly message: string }
  | { readonly kind: "upstream"; readonly message: string; readonly status?: number }
  | { readonly kind: "translate"; readonly message: string }
  | { readonly kind: "body_too_large"; readonly message: string }
  | { readonly kind: "timeout"; readonly message: string }
  | { readonly kind: "client_disconnected"; readonly message: string };

export type AnthropicErrorType =
  | "invalid_request_error"
  | "authentication_error"
  | "permission_error"
  | "rate_limit_error"
  | "api_error"
  | "overloaded_error";

export interface AnthropicError {
  readonly status: number;
  readonly type: AnthropicErrorType;
}

/** Map a Codex upstream HTTP status onto the Anthropic error taxonomy Claude Code understands. */
export const codexStatusToAnthropicError = (status: number): AnthropicError => {
  if (status === 400) return { status: 400, type: "invalid_request_error" };
  if (status === 401) return { status: 401, type: "authentication_error" };
  if (status === 403) return { status: 403, type: "permission_error" };
  if (status === 429) return { status: 429, type: "rate_limit_error" };
  if (status >= 400 && status < 500) return { status, type: "invalid_request_error" };
  return { status: status >= 500 ? status : 502, type: "api_error" };
};

export const proxyErrorToAnthropic = (error: ProxyError): AnthropicError => {
  switch (error.kind) {
    case "auth":
      return { status: 401, type: "authentication_error" };
    case "upstream":
      return codexStatusToAnthropicError(error.status ?? 502);
    case "translate":
      return { status: 400, type: "invalid_request_error" };
    case "body_too_large":
      return { status: 413, type: "invalid_request_error" };
    case "timeout":
      return { status: 504, type: "api_error" };
    case "client_disconnected":
      return { status: 499, type: "api_error" };
  }
};

export const toAnthropicErrorBody = (type: AnthropicErrorType, message: string): string =>
  JSON.stringify({ type: "error", error: { type, message } });

export const toAnthropicErrorSse = (type: AnthropicErrorType, message: string): string =>
  `event: error\ndata: ${toAnthropicErrorBody(type, message)}\n\n`;
