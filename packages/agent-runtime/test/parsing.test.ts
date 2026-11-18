import { TOOL_NAMES } from "@freebuff/shared";
import type { JsonSchema } from "@freebuff/shared";
import type { ProviderEvent } from "@freebuff/llm-providers";
import { describe, expect, test } from "vitest";

import { ToolCallAccumulator, parseToolCalls } from "../src/parsing";

const READ_SCHEMA: JsonSchema = {
  type: "object",
  properties: { path: { type: "string" } },
  required: ["path"],
  additionalProperties: false,
};

const context = {
  knownTools: new Set<string>([TOOL_NAMES.readFile, TOOL_NAMES.editFile]),
  schemaFor: (toolName: string) => (toolName === TOOL_NAMES.readFile ? READ_SCHEMA : undefined),
};

function accumulate(events: readonly ProviderEvent[]) {
  const accumulator = new ToolCallAccumulator();
  for (const event of events) accumulator.apply(event);
  return accumulator.finish();
}

describe("ToolCallAccumulator", () => {
  test("ignores interleaved text and thinking deltas", () => {
    const drafts = accumulate([
      { type: "assistant_text_delta", text: "I will read " },
      { type: "tool_call_start", index: 0, toolCallId: "call_1", toolName: "read_file" },
      { type: "thinking_delta", text: "hmm" },
      { type: "tool_call_arguments_delta", index: 0, delta: '{"path":' },
      { type: "assistant_text_delta", text: "the file." },
      { type: "tool_call_arguments_delta", index: 0, delta: '"a.ts"}' },
      { type: "tool_call_end", index: 0 },
      { type: "completed", stopReason: "tool_use" },
    ]);

    expect(drafts).toEqual([
      { index: 0, toolCallId: "call_1", toolName: "read_file", argumentsJson: '{"path":"a.ts"}' },
    ]);
  });

  test("orders out-of-order fragments by index and dedupes duplicate starts", () => {
    const drafts = accumulate([
      { type: "tool_call_start", index: 1, toolCallId: "call_b", toolName: "read_file" },
      { type: "tool_call_start", index: 0, toolCallId: "call_a", toolName: "read_file" },
      { type: "tool_call_start", index: 1, toolCallId: "call_b", toolName: "read_file" },
      { type: "tool_call_arguments_delta", index: 1, delta: '{"path":"b.ts"}' },
      { type: "tool_call_arguments_delta", index: 0, delta: '{"path":"a.ts"}' },
    ]);

    expect(drafts.map((draft) => draft.toolCallId)).toEqual(["call_a", "call_b"]);
    expect(drafts.map((draft) => draft.argumentsJson)).toEqual([
      '{"path":"a.ts"}',
      '{"path":"b.ts"}',
    ]);
  });

  test("ignores argument fragments for indices that never started", () => {
    expect(accumulate([{ type: "tool_call_arguments_delta", index: 3, delta: '{"x":1}' }])).toEqual(
      [],
    );
  });
});

describe("parseToolCalls determinism on adversarial input", () => {
  const base = { index: 0, toolCallId: "call_1", toolName: TOOL_NAMES.readFile };

  test("rejects malformed JSON", () => {
    const [outcome] = parseToolCalls([{ ...base, argumentsJson: '{"path": ' }], context);
    expect(outcome?.ok).toBe(false);
    expect(outcome?.ok === false && outcome.error).toContain("not valid JSON");
  });

  test("rejects truncated JSON from a cut stream", () => {
    const [outcome] = parseToolCalls([{ ...base, argumentsJson: '{"path":"a.t' }], context);
    expect(outcome?.ok).toBe(false);
    expect(outcome?.ok === false && outcome.raw).toBe('{"path":"a.t');
  });

  test("rejects non-object arguments", () => {
    const [outcome] = parseToolCalls([{ ...base, argumentsJson: "[1,2,3]" }], context);
    expect(outcome?.ok).toBe(false);
  });

  test("rejects unknown tools", () => {
    const [outcome] = parseToolCalls(
      [{ ...base, toolName: "rm_rf", argumentsJson: "{}" }],
      context,
    );
    expect(outcome?.ok === false && outcome.error).toContain("Unknown tool");
  });

  test("rejects schema violations", () => {
    const [outcome] = parseToolCalls([{ ...base, argumentsJson: "{}" }], context);
    expect(outcome?.ok).toBe(false);
    expect(outcome?.ok === false && outcome.error).toContain("required property is missing");
  });

  test("rejects unexpected properties", () => {
    const [outcome] = parseToolCalls(
      [{ ...base, argumentsJson: '{"path":"a.ts","sudo":true}' }],
      context,
    );
    expect(outcome?.ok === false && outcome.error).toContain("unexpected property");
  });

  test("treats empty arguments as an empty object", () => {
    const [outcome] = parseToolCalls(
      [{ ...base, toolName: TOOL_NAMES.editFile, argumentsJson: "" }],
      context,
    );
    if (outcome?.ok !== true) throw new Error("expected an invocation");
    expect(outcome.invocation.input).toEqual({});
  });

  test("parsing the same drafts twice yields identical results", () => {
    const drafts = [
      { ...base, argumentsJson: '{"path":"a.ts"}' },
      { index: 1, toolCallId: "call_2", toolName: TOOL_NAMES.readFile, argumentsJson: "{" },
    ];
    const first = parseToolCalls(drafts, context);
    const second = parseToolCalls(drafts, context);
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
  });

  test("handles many drafts without reordering", () => {
    const drafts = Array.from({ length: 12 }, (_value, index) => ({
      index,
      toolCallId: `call_${String(index)}`,
      toolName: TOOL_NAMES.readFile,
      argumentsJson: '{"path":"a.ts"}',
    }));

    const outcomes = parseToolCalls(drafts, context);
    expect(
      outcomes.map((outcome) => (outcome.ok ? outcome.invocation.toolCallId : undefined)),
    ).toEqual(drafts.map((draft) => draft.toolCallId));
  });
});
