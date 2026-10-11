/** Synthetic structural fixtures; no native client, inference or credentials. */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { describeNativeHistory } from "../../e2e/gates/native-history-observer.js";

describe("sanitized native history observer", () => {
  it("emits only closed structural notice codes and equality flags", () => {
    const secret = "private prompt content must not be captured";
    const description = describeNativeHistory({
      input: [
        { role: "developer", content: [{ type: "input_text", text: secret }] },
        { role: "user", content: secret },
        { role: "developer", content: [{ type: "input_text", text: secret }] },
        {
          role: "developer",
          content: `<multi_agent_mode>${secret}</multi_agent_mode>`,
        },
        { role: secret, type: secret, content: secret },
        { type: "function_call", name: secret, arguments: secret },
      ],
    });
    assert.equal(JSON.stringify(description).includes(secret), false);
    assert.equal(description[2]?.noticeCode, "repeated_initial_instruction");
    assert.equal(description[2]?.matchesInitialInstruction, true);
    assert.equal(description[3]?.noticeCode, "multi_agent_mode");
    assert.deepEqual(description[4], {
      index: 4,
      type: "unknown",
      role: "none",
    });
  });
  it("bounds observations and keeps every key, role, type, and notice classification allowlisted", () => {
    // Fabricated secret-shaped canary verifies that diagnostic output omits content.
    const secret = "Bearer sk-secret-example_private_prompt_tool_contents";
    const input = Array.from({ length: 4096 }, (_, index) =>
      index % 3 === 0
        ? {
            role: "developer",
            type: "message",
            content: [
              {
                type: "input_text",
                text: `${secret}<current_time_reminder>${secret}</current_time_reminder><model_switch>${secret}</model_switch>`,
              },
            ],
            extra: secret,
          }
        : {
            role: index % 3 === 1 ? "user" : secret,
            type: index % 3 === 1 ? "message" : secret,
            content: secret,
            name: secret,
            arguments: secret,
          },
    );
    const rows = describeNativeHistory({
      input,
      instructions: secret,
      tools: [{ name: secret }],
    });
    const keys = new Set([
      "index",
      "type",
      "role",
      "noticeCode",
      "matchesInitialInstruction",
      "containedNotices",
    ]);
    const roles = new Set(["system", "developer", "user", "assistant", "none"]);
    const types = new Set([
      "message",
      "agent_message",
      "additional_tools",
      "function_call",
      "function_call_output",
      "custom_tool_call",
      "custom_tool_call_output",
      "reasoning",
      "compaction",
      "unknown",
    ]);
    const notices = new Set([
      "turn_aborted",
      "multi_agent_mode",
      "multi_agent_role",
      "collaboration_mode",
      "permissions_instructions",
      "managed_developer_instructions",
      "current_time_reminder",
      "current_time_unavailable",
      "model_catalog",
      "model_switch",
      "instruction_shape_unrecognized",
      "instruction_unrecognized",
      "repeated_initial_instruction",
    ]);
    assert.equal(rows.length, 512);
    for (const row of rows) {
      assert.ok(Object.keys(row).every((key) => keys.has(key)));
      assert.ok(roles.has(row.role));
      assert.ok(types.has(row.type));
      if (row.noticeCode) assert.ok(notices.has(row.noticeCode));
      if (row.containedNotices)
        assert.ok(row.containedNotices.every((notice) => notices.has(notice)));
    }
    const encoded = JSON.stringify(rows);
    assert.equal(encoded.includes(secret), false);
    assert.ok(Buffer.byteLength(encoded) < 65536);
  });
});
