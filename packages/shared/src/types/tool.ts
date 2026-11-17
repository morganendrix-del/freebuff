import type { Id } from "./ids";
import type { JsonObject, JsonSchema } from "./json";
import type { AgentPermissions } from "./permissions";

/**
 * Provider-assigned tool call identifier (e.g. `call_abc123`). Opaque: it is echoed back to the
 * provider verbatim, so it must never be re-generated or parsed.
 */
export type ToolCallId = string;

/** Canonical tool names. The registry and every provider shim share this table. */
export const TOOL_NAMES = {
  readFile: "read_file",
  writeFile: "write_file",
  editFile: "edit_file",
  multiEdit: "multi_edit",
  search: "ripgrep",
  runCommand: "run_command",
  webFetch: "web_fetch",
  codeMapQuery: "code_map_query",
  delegateSubagent: "delegate_subagent",
} as const;

export type ToolName = (typeof TOOL_NAMES)[keyof typeof TOOL_NAMES];

export type ToolCategory =
  "code_intelligence" | "filesystem" | "network" | "search" | "shell" | "subagent";

export type ToolRisk = "execute" | "network" | "read" | "write";

export interface ToolDefinition {
  readonly name: ToolName;
  readonly description: string;
  readonly category: ToolCategory;
  readonly risk: ToolRisk;
  readonly inputSchema: JsonSchema;
  readonly timeoutMs: number;
  readonly idempotent: boolean;
}

export interface ToolInvocation {
  readonly toolCallId: ToolCallId;
  readonly toolName: ToolName;
  readonly input: JsonObject;
}

export type ToolErrorCode =
  | "cancelled"
  | "execution_failed"
  | "invalid_input"
  | "not_found"
  | "output_too_large"
  | "permission_denied"
  | "timeout";

export interface ToolError {
  readonly code: ToolErrorCode;
  readonly message: string;
  readonly retryable: boolean;
}

export type ToolOutcome =
  | {
      readonly ok: true;
      readonly summary: string;
      readonly output: JsonObject;
      readonly durationMs: number;
    }
  | {
      readonly ok: false;
      readonly summary: string;
      readonly error: ToolError;
      readonly durationMs: number;
    };

export interface ToolExecutionContext {
  readonly sessionId: Id<"session">;
  readonly projectRoot: string;
  readonly sandboxId?: Id<"sandbox">;
  readonly signal: AbortSignal;
  readonly permissions: AgentPermissions;
  readonly toolCallId: ToolCallId;
}

/** Deterministic parse result for a provider tool-call block. */
export type ToolCallParseOutcome =
  | { readonly ok: true; readonly invocation: ToolInvocation }
  | { readonly ok: false; readonly error: string; readonly raw: string };
