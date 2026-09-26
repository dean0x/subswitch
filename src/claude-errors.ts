/** Every translation failure has an explicit client status; new codes must choose one. */
export const CLAUDE_ERROR_STATUS = {
  namespace_collision: 400,
  invalid_plaintext_call: 400,
  claude_event_after_terminal: 502,
  claude_response_too_large: 502,
  claude_retry_bound: 502,
  claude_stream_error: 502,
  claude_thinking_state_unimplemented: 409,
  concurrent_claude_stream_id: 409,
  cross_provider_state_unavailable: 409,
  discovery_response_too_large: 502,
  duplicate_claude_start: 502,
  duplicate_or_missing_tool_call_id: 502,
  duplicate_tool_call: 400,
  encrypted_tool_arguments: 400,
  expected_object: 400,
  expected_string: 400,
  foreign_opaque_state: 409,
  incomplete_claude_response: 502,
  inconsistent_stop_reason: 502,
  invalid_additional_tools: 400,
  invalid_claude_block_index: 502,
  invalid_claude_block_stop: 502,
  invalid_claude_delta: 502,
  invalid_claude_event: 502,
  invalid_claude_message_delta: 502,
  invalid_claude_response: 502,
  invalid_claude_start: 502,
  invalid_claude_tool_arguments: 502,
  invalid_custom_tool_input: 502,
  invalid_input_item: 400,
  invalid_json_body: 400,
  invalid_opaque_state: 409,
  invalid_or_oversized_compressed_body: 413,
  invalid_output_limit: 400,
  invalid_previous_response_id: 400,
  invalid_state_key: 500,
  invalid_tool_arguments: 400,
  invalid_tools: 400,
  invalid_upstream_body: 502,
  json_nesting_too_deep: 400,
  mid_history_instructions_unimplemented: 400,
  missing_claude_body: 502,
  missing_claude_replay_state: 409,
  missing_claude_start: 502,
  missing_claude_terminal: 502,
  missing_continuation_state: 409,
  missing_tool_result: 400,
  nontext_system: 400,
  opaque_state_unimplemented: 409,
  reasoning_effort_unsupported_by_model: 400,
  request_too_large: 413,
  state_history_mismatch: 409,
  structured_output_unimplemented: 400,
  tool_choice_unsupported_by_model: 400,
  tool_definition_conflict: 400,
  translated_compaction_unavailable: 400,
  unknown_claude_tool: 502,
  unknown_tool: 400,
  unmatched_tool_result: 400,
  unregistered_claude_model: 400,
  unsupported_claude_delta: 502,
  unsupported_claude_event: 502,
  unsupported_claude_output: 502,
  unsupported_content: 400,
  unsupported_content_block: 400,
  unsupported_content_encoding: 415,
  unsupported_hosted_tool: 400,
  unsupported_image: 400,
  unsupported_input: 400,
  unsupported_input_item: 400,
  unsupported_message_role: 400,
  unsupported_namespace: 400,
  unsupported_reasoning_effort: 400,
  unsupported_tool_choice: 400,
  unsupported_tool_result_content: 400,
  unterminated_claude_block: 502,
  upstream_connection_failed: 502,
  upstream_response_missing: 502,
} as const;
export type ClaudeErrorCode = keyof typeof CLAUDE_ERROR_STATUS;

export class ReverseContractError extends Error {
  /**
   * `detail` replaces the generic client message when the code alone cannot tell the
   * user what to change. It is rendered through openaiError, so it inherits the
   * render-site redaction (applies ADR-008); any caller-supplied value in it must
   * already be bounded and neutralized.
   */
  constructor(
    readonly code: ClaudeErrorCode,
    readonly detail?: string,
  ) {
    super(code);
  }
}

export class ClaudeHttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code: string,
    readonly retryAfter?: string,
  ) {
    super(message);
  }
}

const STATE_MESSAGES: Partial<Record<ClaudeErrorCode, string>> = {
  missing_claude_replay_state: "Claude continuation state is no longer available in this SubSwitch process. Start a new conversation.",
  missing_continuation_state: "This response's continuation state is no longer available. Start a new conversation.",
  invalid_opaque_state: "Claude continuation state is invalid or belongs to a previous SubSwitch process. Start a new conversation.",
};

export const claudeFailure = (error: unknown) => {
  if (error instanceof ClaudeHttpError)
    return { status: error.status, message: error.message, code: error.code, retryAfter: error.retryAfter };
  if (error instanceof Error && "code" in error && error.code === "ETIMEDOUT")
    return { status: 504, message: "OpenAI connection timed out.", code: "openai_timeout", retryAfter: undefined };
  const code = error instanceof ReverseContractError ? error.code : "upstream_connection_failed";
  return {
    status: CLAUDE_ERROR_STATUS[code],
    code,
    message:
      (error instanceof ReverseContractError ? error.detail : undefined) ??
      STATE_MESSAGES[code] ??
      `SubSwitch could not translate this request (${code}).`,
    retryAfter: undefined,
  };
};
