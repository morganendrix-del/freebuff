import type {
  CircuitBreaker,
  JsonSchema,
  ModelSpec,
  ProviderId,
  RetryPolicy,
  TokenUsage,
  ToolCallId,
} from "@freebuff/shared";

export interface ToolDeclaration {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: JsonSchema;
}

export interface ProviderToolCall {
  readonly toolCallId: ToolCallId;
  readonly toolName: string;
  /** Raw JSON arguments exactly as the provider emitted them; parsed by the agent runtime. */
  readonly argumentsJson: string;
}

export interface ProviderToolResult {
  readonly toolCallId: ToolCallId;
  readonly toolName: string;
  readonly content: string;
  readonly isError: boolean;
}

/** One conversation turn in provider-neutral form. */
export interface ProviderTurn {
  readonly role: "assistant" | "user";
  readonly text: string;
  readonly toolCalls?: readonly ProviderToolCall[];
  readonly toolResults?: readonly ProviderToolResult[];
}

export interface ProviderRequest {
  readonly model: ModelSpec;
  readonly systemPrompt: string;
  readonly turns: readonly ProviderTurn[];
  readonly tools: readonly ToolDeclaration[];
  readonly temperature?: number;
  readonly maxOutputTokens?: number;
}

export type ProviderStopReason =
  "content_filter" | "end_turn" | "max_tokens" | "tool_use" | "unknown";

/**
 * Normalised streaming events. Adapters translate provider wire formats into exactly this shape, so
 * the agent loop never learns a provider's dialect.
 */
export type ProviderEvent =
  | { readonly type: "assistant_text_delta"; readonly text: string }
  | { readonly type: "thinking_delta"; readonly text: string }
  | {
      readonly type: "tool_call_start";
      readonly index: number;
      readonly toolCallId: ToolCallId;
      readonly toolName: string;
    }
  | { readonly type: "tool_call_arguments_delta"; readonly index: number; readonly delta: string }
  | { readonly type: "tool_call_end"; readonly index: number }
  | { readonly type: "usage"; readonly usage: TokenUsage }
  | { readonly type: "completed"; readonly stopReason: ProviderStopReason };

export interface TransportRequest {
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
  readonly signal: AbortSignal;
}

/** HTTP port. Production uses `fetch`; tests replay recorded exchanges. */
export type Transport = (request: TransportRequest) => Promise<Response>;

export interface StreamOptions {
  readonly signal: AbortSignal;
}

export interface LlmProvider {
  readonly id: ProviderId;
  stream(request: ProviderRequest, options: StreamOptions): AsyncGenerator<ProviderEvent>;
}

/** Construction options shared by every provider factory. */
export interface ProviderFactoryOptions {
  readonly apiKey: string;
  readonly baseUrl?: string;
  readonly transport?: Transport;
  readonly timeoutMs?: number;
  readonly retryPolicy?: RetryPolicy;
  readonly breaker?: CircuitBreaker;
}
