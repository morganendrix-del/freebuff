import {
  CancelledError,
  PlatformError,
  TimeoutError,
  toErrorMessage,
  withTimeout,
} from "@freebuff/shared";
import type {
  AgentPermissions,
  JsonObject,
  JsonSchema,
  ToolDefinition,
  ToolError,
  ToolErrorCode,
  ToolExecutionContext,
  ToolInvocation,
  ToolOutcome,
} from "@freebuff/shared";

const TOOL_ERROR_CODES: ReadonlySet<string> = new Set<ToolErrorCode>([
  "cancelled",
  "execution_failed",
  "invalid_input",
  "not_found",
  "output_too_large",
  "permission_denied",
  "timeout",
]);

export interface ToolBinding {
  readonly definition: ToolDefinition;
  execute(input: JsonObject, context: ToolExecutionContext): Promise<ToolOutcome>;
}

export type ToolContextInput = Omit<ToolExecutionContext, "toolCallId">;

function failure(
  error: ToolError,
  summary: string,
  durationMs: number,
): Extract<ToolOutcome, { ok: false }> {
  return { ok: false, summary, error, durationMs };
}

function permissionError(definition: ToolDefinition): ToolError | undefined {
  if (definition.risk === "write") {
    return {
      code: "permission_denied",
      message: "File writes are not permitted.",
      retryable: false,
    };
  }
  if (definition.risk === "execute") {
    return {
      code: "permission_denied",
      message: "Shell commands are not permitted.",
      retryable: false,
    };
  }
  if (definition.risk === "network") {
    return {
      code: "permission_denied",
      message: "Network access is not permitted.",
      retryable: false,
    };
  }
  return undefined;
}

function allows(definition: ToolDefinition, permissions: AgentPermissions): boolean {
  switch (definition.risk) {
    case "read":
      return true;
    case "write":
      return permissions.allowFileWrites;
    case "execute":
      return permissions.allowShellCommands;
    case "network":
      return permissions.allowNetwork;
  }
}

/** Tool registry: the only path from a model tool call to real work. */
export class ToolRegistry {
  private readonly bindings = new Map<string, ToolBinding>();

  register(binding: ToolBinding): this {
    this.bindings.set(binding.definition.name, binding);
    return this;
  }

  get(toolName: string): ToolBinding | undefined {
    return this.bindings.get(toolName);
  }

  definitions(): readonly ToolDefinition[] {
    return [...this.bindings.values()].map((binding) => binding.definition);
  }

  names(): ReadonlySet<string> {
    return new Set(this.bindings.keys());
  }

  schemaFor(toolName: string): JsonSchema | undefined {
    return this.bindings.get(toolName)?.definition.inputSchema;
  }

  async execute(invocation: ToolInvocation, context: ToolContextInput): Promise<ToolOutcome> {
    const startedAt = performance.now();
    const binding = this.bindings.get(invocation.toolName);
    if (!binding) {
      return failure(
        { code: "not_found", message: `Unknown tool "${invocation.toolName}".`, retryable: false },
        "unknown tool",
        performance.now() - startedAt,
      );
    }

    if (!allows(binding.definition, context.permissions)) {
      const denied = permissionError(binding.definition);
      return failure(
        denied ?? {
          code: "permission_denied",
          message: "Tool is not permitted.",
          retryable: false,
        },
        `blocked by permissions: ${invocation.toolName}`,
        performance.now() - startedAt,
      );
    }

    try {
      const outcome = await withTimeout(
        (signal) =>
          binding.execute(invocation.input, {
            ...context,
            toolCallId: invocation.toolCallId,
            signal,
          }),
        binding.definition.timeoutMs,
        `Tool "${invocation.toolName}" timed out.`,
        context.signal,
      );
      return outcome;
    } catch (error) {
      const durationMs = performance.now() - startedAt;
      if (error instanceof TimeoutError) {
        return failure(
          { code: "timeout", message: error.message, retryable: true },
          `timed out: ${invocation.toolName}`,
          durationMs,
        );
      }
      if (error instanceof CancelledError) {
        return failure(
          { code: "cancelled", message: "Tool call cancelled.", retryable: false },
          `cancelled: ${invocation.toolName}`,
          durationMs,
        );
      }
      if (error instanceof PlatformError && TOOL_ERROR_CODES.has(error.code)) {
        return failure(
          { code: error.code as ToolErrorCode, message: error.message, retryable: error.retryable },
          `failed: ${invocation.toolName}`,
          durationMs,
        );
      }
      return failure(
        { code: "execution_failed", message: toErrorMessage(error), retryable: false },
        `failed: ${invocation.toolName}`,
        durationMs,
      );
    }
  }
}
