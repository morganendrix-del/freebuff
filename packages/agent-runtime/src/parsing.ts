import type { JsonSchema, ToolCallParseOutcome, ToolName } from "@freebuff/shared";
import type { ProviderEvent } from "@freebuff/llm-providers";

import { asJsonObject, validateJsonSchema } from "./json-schema";

export type { ToolCallParseOutcome };

export interface ToolCallDraft {
  readonly index: number;
  readonly toolCallId: string;
  readonly toolName: string;
  readonly argumentsJson: string;
}

/**
 * Accumulates streamed tool-call fragments. Index-based, so interleaved text, out-of-order or
 * duplicate fragments all resolve deterministically.
 */
export class ToolCallAccumulator {
  private readonly drafts = new Map<
    number,
    { toolCallId: string; toolName: string; chunks: string[] }
  >();

  apply(event: ProviderEvent): void {
    switch (event.type) {
      case "tool_call_start": {
        const existing = this.drafts.get(event.index);
        if (existing) {
          existing.toolCallId = event.toolCallId;
          if (existing.toolName === "") existing.toolName = event.toolName;
        } else {
          this.drafts.set(event.index, {
            toolCallId: event.toolCallId,
            toolName: event.toolName,
            chunks: [],
          });
        }
        break;
      }
      case "tool_call_arguments_delta": {
        const existing = this.drafts.get(event.index);
        if (existing) existing.chunks.push(event.delta);
        break;
      }
      case "tool_call_end":
      case "assistant_text_delta":
      case "thinking_delta":
      case "usage":
      case "completed":
        break;
    }
  }

  /** Completed drafts in provider index order. */
  finish(): ToolCallDraft[] {
    return [...this.drafts.entries()]
      .sort(([left], [right]) => left - right)
      .map(([index, draft]) => ({
        index,
        toolCallId: draft.toolCallId,
        toolName: draft.toolName,
        argumentsJson: draft.chunks.join(""),
      }));
  }

  reset(): void {
    this.drafts.clear();
  }
}

export interface ToolParseContext {
  readonly knownTools: ReadonlySet<string>;
  readonly schemaFor: (toolName: string) => JsonSchema | undefined;
}

/** Turns drafts into invocations or explicit, human-readable failures. Never throws. */
export function parseToolCalls(
  drafts: readonly ToolCallDraft[],
  context: ToolParseContext,
): ToolCallParseOutcome[] {
  return drafts.map((draft) => {
    if (draft.toolName === "") {
      return { ok: false, error: "Tool call is missing a name.", raw: draft.argumentsJson };
    }
    if (!context.knownTools.has(draft.toolName)) {
      return {
        ok: false,
        error: `Unknown tool "${draft.toolName}".`,
        raw: draft.argumentsJson,
      };
    }

    let parsed: unknown;
    const raw = draft.argumentsJson.trim() === "" ? "{}" : draft.argumentsJson;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return {
        ok: false,
        error: `Arguments for "${draft.toolName}" are not valid JSON.`,
        raw: draft.argumentsJson,
      };
    }

    const input = asJsonObject(parsed);
    if (!input) {
      return {
        ok: false,
        error: `Arguments for "${draft.toolName}" must be a JSON object.`,
        raw: draft.argumentsJson,
      };
    }

    const schema = context.schemaFor(draft.toolName);
    if (schema) {
      const validation = validateJsonSchema(input, schema);
      if (!validation.ok) {
        return {
          ok: false,
          error: `Invalid arguments for "${draft.toolName}": ${validation.errors.join("; ")}`,
          raw: draft.argumentsJson,
        };
      }
    }

    return {
      ok: true,
      invocation: {
        toolCallId: draft.toolCallId,
        toolName: draft.toolName as ToolName,
        input,
      },
    };
  });
}
