import {
  AGENT_LOOP_DEFAULTS,
  DEFAULT_AGENT_PERMISSIONS,
  TOOL_NAMES,
  createId,
  toErrorMessage,
} from "@freebuff/shared";
import type {
  AgentEvent,
  AgentFailure,
  AgentMessage,
  AgentPermissions,
  AgentRunResult,
  AgentRunStatus,
  AgentLoopLimits,
  Id,
  JsonObject,
  JsonValue,
  ModelSpec,
  SubagentResult,
  TerminationReason,
  TokenUsage,
  ToolOutcome,
} from "@freebuff/shared";
import type {
  LlmProvider,
  ProviderRequest,
  ProviderStopReason,
  ProviderToolCall,
  ProviderToolResult,
  ProviderTurn,
} from "@freebuff/llm-providers";

import { CancellationScope } from "./cancellation";
import { EventQueue } from "./events";
import { parseToolCalls, ToolCallAccumulator } from "./parsing";
import type { ToolRegistry } from "./registry";
import { parseDelegationTasks } from "./tools/other-tools";

export interface AgentLoopOptions {
  readonly sessionId: Id<"session">;
  readonly projectRoot: string;
  readonly model: ModelSpec;
  readonly provider: LlmProvider;
  readonly registry: ToolRegistry;
  readonly systemPrompt: string;
  readonly limits?: AgentLoopLimits;
  readonly permissions?: AgentPermissions;
  readonly maxTokenBudget?: number;
  readonly onEvent?: (event: AgentEvent) => void;
}

export interface AgentRunHandle {
  readonly events: AsyncIterable<AgentEvent>;
  readonly result: Promise<AgentRunResult>;
  cancel(reason?: string): void;
}

function addUsage(total: TokenUsage, delta: TokenUsage): TokenUsage {
  return {
    inputTokens: total.inputTokens + delta.inputTokens,
    outputTokens: total.outputTokens + delta.outputTokens,
    ...(total.cachedInputTokens === undefined && delta.cachedInputTokens === undefined
      ? {}
      : { cachedInputTokens: (total.cachedInputTokens ?? 0) + (delta.cachedInputTokens ?? 0) }),
  };
}

function failureFrom(error: unknown): AgentFailure {
  return {
    code: "agent_error",
    message: toErrorMessage(error),
    retryable: false,
  };
}

async function mapWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;

  const runners = Array.from({ length: Math.max(1, Math.min(concurrency, items.length)) }, () =>
    (async () => {
      while (true) {
        const index = cursor;
        cursor += 1;
        const item = items[index];
        if (item === undefined) return;
        results[index] = await worker(item, index);
      }
    })(),
  );

  await Promise.all(runners);
  return results;
}

/** Runs a full agent loop, streaming `AgentEvent`s and resolving to the final result. */
export function startAgentRun(options: AgentLoopOptions, prompt: string): AgentRunHandle {
  const queue = new EventQueue<AgentEvent>();
  const scope = new CancellationScope();
  const runId = createId("run");
  const limits = options.limits ?? AGENT_LOOP_DEFAULTS;
  const permissions = options.permissions ?? DEFAULT_AGENT_PERMISSIONS;
  // Read through a function: `scope.cancelled` is a getter that changes underneath the loop.
  const isCancelled = (): boolean => scope.cancelled;

  const emit = (event: AgentEvent): void => {
    try {
      options.onEvent?.(event);
    } catch {
      // A consumer callback must never break the run.
    }
    queue.push(event);
  };

  const execute = async (): Promise<AgentRunResult> => {
    const turns: ProviderTurn[] = [{ role: "user", text: prompt }];
    const messages: AgentMessage[] = [
      {
        id: createId("message"),
        role: "user",
        content: [{ type: "text", text: prompt }],
        createdAt: new Date().toISOString(),
      },
    ];
    let usage: TokenUsage = { inputTokens: 0, outputTokens: 0 };
    let steps = 0;

    const result = (
      status: AgentRunStatus,
      reason: TerminationReason,
      failure?: AgentFailure,
    ): AgentRunResult => ({
      runId,
      status,
      reason,
      messages,
      usage,
      steps,
      ...(failure === undefined ? {} : { failure }),
    });

    emit({ type: "run_started", runId, sessionId: options.sessionId, modelId: options.model.id });

    while (steps < limits.maxSteps) {
      if (isCancelled()) {
        emit({ type: "run_cancelled", reason: "Run cancelled." });
        return result("cancelled", "cancelled");
      }

      steps += 1;
      emit({ type: "step_started", step: steps });

      const accumulator = new ToolCallAccumulator();
      let assistantText = "";
      let stopReason: ProviderStopReason = "unknown";
      let streamError: unknown;

      const request: ProviderRequest = {
        model: options.model,
        systemPrompt: options.systemPrompt,
        turns,
        tools: options.registry.definitions().map((definition) => ({
          name: definition.name,
          description: definition.description,
          inputSchema: definition.inputSchema,
        })),
      };

      try {
        for await (const event of options.provider.stream(request, { signal: scope.signal })) {
          accumulator.apply(event);
          switch (event.type) {
            case "assistant_text_delta":
              assistantText += event.text;
              emit({ type: "assistant_delta", text: event.text });
              break;
            case "thinking_delta":
              emit({ type: "thinking_delta", text: event.text });
              break;
            case "usage":
              usage = addUsage(usage, event.usage);
              emit({ type: "usage", usage: event.usage });
              break;
            case "completed":
              stopReason = event.stopReason;
              break;
            case "tool_call_start":
            case "tool_call_arguments_delta":
            case "tool_call_end":
              break;
          }
        }
      } catch (error) {
        streamError = error;
      }

      if (isCancelled()) {
        emit({ type: "run_cancelled", reason: "Run cancelled." });
        return result("cancelled", "cancelled");
      }

      if (streamError !== undefined) {
        const failure = failureFrom(streamError);
        emit({ type: "run_failed", failure });
        return result("failed", "error", failure);
      }

      const drafts = accumulator.finish();
      const toolCalls: ProviderToolCall[] = drafts.map((draft) => ({
        toolCallId: draft.toolCallId,
        toolName: draft.toolName,
        argumentsJson: draft.argumentsJson,
      }));

      turns.push({
        role: "assistant",
        text: assistantText,
        ...(toolCalls.length === 0 ? {} : { toolCalls }),
      });
      messages.push({
        id: createId("message"),
        role: "assistant",
        content: [
          ...(assistantText === "" ? [] : [{ type: "text" as const, text: assistantText }]),
          ...toolCalls.map((call) => ({
            type: "tool_use" as const,
            toolCallId: call.toolCallId,
            toolName: call.toolName,
            input: JSON.parse(call.argumentsJson === "" ? "{}" : call.argumentsJson) as JsonValue,
          })),
        ],
        createdAt: new Date().toISOString(),
      });

      if (
        options.maxTokenBudget !== undefined &&
        usage.inputTokens + usage.outputTokens > options.maxTokenBudget
      ) {
        emit({
          type: "run_completed",
          status: "step_limit",
          reason: "token_budget_exhausted",
          usage,
        });
        return result("step_limit", "token_budget_exhausted");
      }

      if (drafts.length === 0) {
        emit({ type: "run_completed", status: "completed", reason: "assistant_finished", usage });
        return result("completed", "assistant_finished");
      }

      const outcomes = parseToolCalls(drafts, {
        knownTools: options.registry.names(),
        schemaFor: (toolName) => options.registry.schemaFor(toolName),
      });

      const toolResults: ProviderToolResult[] = [];

      for (const [index, outcome] of outcomes.entries()) {
        const draft = drafts[index];
        if (draft === undefined) continue;

        if (isCancelled()) {
          emit({ type: "run_cancelled", reason: "Run cancelled." });
          return result("cancelled", "cancelled");
        }

        if (index >= limits.maxToolCallsPerStep) {
          const skipped = `Too many tool calls in one step (limit ${String(
            limits.maxToolCallsPerStep,
          )}).`;
          emit({
            type: "tool_result",
            toolCallId: draft.toolCallId,
            toolName: draft.toolName,
            ok: false,
            summary: skipped,
            durationMs: 0,
          });
          toolResults.push({
            toolCallId: draft.toolCallId,
            toolName: draft.toolName,
            content: skipped,
            isError: true,
          });
          continue;
        }

        if (!outcome.ok) {
          emit({
            type: "tool_result",
            toolCallId: draft.toolCallId,
            toolName: draft.toolName,
            ok: false,
            summary: outcome.error,
            durationMs: 0,
          });
          toolResults.push({
            toolCallId: draft.toolCallId,
            toolName: draft.toolName,
            content: outcome.error,
            isError: true,
          });
          continue;
        }

        const invocation = outcome.invocation;
        emit({
          type: "tool_call",
          toolCallId: invocation.toolCallId,
          toolName: invocation.toolName,
          input: invocation.input,
        });

        const toolOutcome =
          invocation.toolName === TOOL_NAMES.delegateSubagent
            ? await runDelegation(invocation.input)
            : await options.registry.execute(invocation, {
                sessionId: options.sessionId,
                projectRoot: options.projectRoot,
                signal: scope.signal,
                permissions,
              });

        emit({
          type: "tool_result",
          toolCallId: invocation.toolCallId,
          toolName: invocation.toolName,
          ok: toolOutcome.ok,
          summary: toolOutcome.summary,
          durationMs: toolOutcome.durationMs,
        });

        toolResults.push({
          toolCallId: invocation.toolCallId,
          toolName: invocation.toolName,
          content: toolOutcome.ok ? toolOutcome.summary : toolOutcome.error.message,
          isError: !toolOutcome.ok,
        });
      }

      turns.push({ role: "user", text: "", toolResults });
      messages.push({
        id: createId("message"),
        role: "tool",
        content: toolResults.map((toolResult) => ({
          type: "tool_result" as const,
          toolCallId: toolResult.toolCallId,
          toolName: toolResult.toolName,
          ok: !toolResult.isError,
          output: toolResult.content,
          durationMs: 0,
        })),
        createdAt: new Date().toISOString(),
      });

      if (isCancelled()) {
        emit({ type: "run_cancelled", reason: "Run cancelled." });
        return result("cancelled", "cancelled");
      }

      if (stopReason === "unknown" && drafts.length === 0) break;
    }

    emit({ type: "run_completed", status: "step_limit", reason: "max_steps", usage });
    return result("step_limit", "max_steps");
  };

  async function runDelegation(input: JsonObject): Promise<ToolOutcome> {
    const startedAt = performance.now();
    if (limits.maxSubagents <= 0) {
      return {
        ok: false,
        summary: "Subagent delegation is disabled for this run.",
        error: {
          code: "permission_denied",
          message: "Subagent delegation is disabled for this run.",
          retryable: false,
        },
        durationMs: performance.now() - startedAt,
      };
    }

    const { tasks, parallel } = parseDelegationTasks(input);
    if (tasks.length === 0) {
      return {
        ok: false,
        summary: "No subagent tasks were provided.",
        error: {
          code: "invalid_input",
          message: "No subagent tasks were provided.",
          retryable: false,
        },
        durationMs: performance.now() - startedAt,
      };
    }

    const selected = tasks.slice(0, limits.maxSubagents);
    const concurrency = parallel ? limits.subagentConcurrency : 1;

    const results = await mapWithConcurrency(selected, concurrency, async (task) => {
      const subagentId = createId("agent");
      emit({
        type: "subagent_started",
        subagentId,
        title: task.title,
        modelId: options.model.id,
      });

      const nested = startAgentRun(
        {
          sessionId: options.sessionId,
          projectRoot: options.projectRoot,
          model: options.model,
          provider: options.provider,
          registry: options.registry,
          systemPrompt: options.systemPrompt,
          permissions,
          limits: { ...limits, maxSubagents: 0 },
          ...(options.maxTokenBudget === undefined
            ? {}
            : { maxTokenBudget: options.maxTokenBudget }),
        },
        task.prompt,
      );

      const unsubscribe = scope.onCancel(() => {
        nested.cancel("Parent run cancelled.");
      });

      const nestedResult = await nested.result;
      unsubscribe();

      const result: SubagentResult = {
        id: subagentId,
        status: nestedResult.status,
        summary:
          nestedResult.messages
            .filter((message) => message.role === "assistant")
            .flatMap((message) => message.content)
            .filter((block) => block.type === "text")
            .map((block) => block.text)
            .join(" ")
            .trim() || nestedResult.reason,
        usage: nestedResult.usage,
        ...(nestedResult.failure === undefined ? {} : { failure: nestedResult.failure }),
      };

      emit({
        type: "subagent_completed",
        subagentId,
        status: result.status,
        summary: result.summary,
      });
      return result;
    });

    const completed = results.filter((entry) => entry.status === "completed").length;
    const summary = results
      .map((entry, index) => `${String(index + 1)}. ${entry.status}: ${entry.summary}`)
      .join("\n");
    const durationMs = performance.now() - startedAt;
    const output: JsonObject = {
      results: results.map((entry) => ({
        id: entry.id,
        status: entry.status,
        summary: entry.summary,
        inputTokens: entry.usage.inputTokens,
        outputTokens: entry.usage.outputTokens,
      })),
    };

    if (completed > 0) {
      return {
        ok: true,
        summary: `Delegated ${String(results.length)} task(s): ${String(completed)} completed.\n${summary}`,
        output,
        durationMs,
      };
    }

    return {
      ok: false,
      summary: `All ${String(results.length)} delegated task(s) failed.\n${summary}`,
      error: {
        code: "execution_failed",
        message: "Every delegated task failed.",
        retryable: false,
      },
      durationMs,
    };
  }

  const result = execute().finally(() => {
    queue.close();
  });

  return {
    events: queue,
    result,
    cancel: (reason) => {
      scope.cancel(reason);
    },
  };
}

/** Convenience wrapper resolving the final result while discarding events. */
export async function runAgent(options: AgentLoopOptions, prompt: string): Promise<AgentRunResult> {
  const handle = startAgentRun(options, prompt);
  return handle.result;
}
