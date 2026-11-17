import type { Id } from "./ids";
import type { JsonValue } from "./json";
import type { ModelCapability, ProviderId } from "./model";
import type { ToolCallId } from "./tool";

export type MessageRole = "assistant" | "system" | "tool" | "user";

export type ContentBlock =
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "thinking"; readonly text: string }
  | {
      readonly type: "tool_use";
      readonly toolCallId: ToolCallId;
      readonly toolName: string;
      readonly input: JsonValue;
    }
  | {
      readonly type: "tool_result";
      readonly toolCallId: ToolCallId;
      readonly toolName: string;
      readonly ok: boolean;
      /** Model-facing summary; never the raw file contents of an unrelated file. */
      readonly output: string;
      readonly durationMs: number;
    };

export interface AgentMessage {
  readonly id: Id<"message">;
  readonly role: MessageRole;
  readonly content: readonly ContentBlock[];
  readonly createdAt: string;
}

export interface TokenUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cachedInputTokens?: number;
}

export type AgentRunStatus = "cancelled" | "completed" | "failed" | "step_limit";

export type TerminationReason =
  "assistant_finished" | "cancelled" | "error" | "max_steps" | "token_budget_exhausted";

export interface AgentFailure {
  readonly code: string;
  readonly message: string;
  readonly retryable: boolean;
  readonly providerId?: ProviderId;
  readonly details?: JsonValue;
}

export interface AgentLoopLimits {
  readonly maxSteps: number;
  readonly maxToolCallsPerStep: number;
  readonly maxSubagents: number;
  readonly subagentConcurrency: number;
}

export interface AgentRuntimeConfig {
  readonly modelId: string;
  readonly providerId: ProviderId;
  readonly requiredCapabilities: readonly ModelCapability[];
  readonly limits: AgentLoopLimits;
  readonly systemPrompt: string;
  readonly temperature?: number;
}

export interface SubagentTask {
  readonly id: Id<"agent">;
  readonly title: string;
  readonly prompt: string;
  readonly tools?: readonly string[];
  readonly modelId?: string;
}

export interface SubagentDelegation {
  readonly parallel: boolean;
  readonly maxConcurrency: number;
  readonly tasks: readonly SubagentTask[];
}

export interface SubagentResult {
  readonly id: Id<"agent">;
  readonly status: AgentRunStatus;
  readonly summary: string;
  readonly usage: TokenUsage;
  readonly failure?: AgentFailure;
}

/** Streaming events. Every surface renders from this union and nothing else. */
export type AgentEvent =
  | {
      readonly type: "run_started";
      readonly runId: Id<"run">;
      readonly sessionId: Id<"session">;
      readonly modelId: string;
    }
  | { readonly type: "step_started"; readonly step: number }
  | { readonly type: "assistant_delta"; readonly text: string }
  | { readonly type: "thinking_delta"; readonly text: string }
  | {
      readonly type: "tool_call";
      readonly toolCallId: ToolCallId;
      readonly toolName: string;
      readonly input: JsonValue;
    }
  | {
      readonly type: "tool_result";
      readonly toolCallId: ToolCallId;
      readonly toolName: string;
      readonly ok: boolean;
      readonly summary: string;
      readonly durationMs: number;
    }
  | {
      readonly type: "subagent_started";
      readonly subagentId: Id<"agent">;
      readonly title: string;
      readonly modelId: string;
    }
  | {
      readonly type: "subagent_completed";
      readonly subagentId: Id<"agent">;
      readonly status: AgentRunStatus;
      readonly summary: string;
    }
  | { readonly type: "usage"; readonly usage: TokenUsage }
  | {
      readonly type: "run_completed";
      readonly status: AgentRunStatus;
      readonly reason: TerminationReason;
      readonly usage: TokenUsage;
    }
  | { readonly type: "run_failed"; readonly failure: AgentFailure }
  | { readonly type: "run_cancelled"; readonly reason: string };

export interface AgentRunResult {
  readonly runId: Id<"run">;
  readonly status: AgentRunStatus;
  readonly reason: TerminationReason;
  readonly messages: readonly AgentMessage[];
  readonly usage: TokenUsage;
  readonly steps: number;
  readonly failure?: AgentFailure;
}
