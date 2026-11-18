import type {
  CircuitBreaker,
  JsonObject,
  JsonValue,
  RetryPolicy,
  TokenUsage,
} from "@freebuff/shared";

import { ProviderError } from "./errors";
import { readSseFrames } from "./sse";
import { openProviderStream } from "./transport";
import type {
  LlmProvider,
  ProviderEvent,
  ProviderRequest,
  ProviderStopReason,
  ProviderTurn,
  StreamOptions,
  Transport,
} from "./types";
import { asNumber, asRecord, asString, parseArgumentsObject, parseStreamPayload } from "./wire";

export const ANTHROPIC_VERSION = "2023-06-01";
const DEFAULT_MAX_OUTPUT_TOKENS = 8_192;

export interface AnthropicConfig {
  readonly apiKey: string;
  readonly baseUrl?: string;
  readonly transport?: Transport;
  readonly timeoutMs?: number;
  readonly retryPolicy?: RetryPolicy;
  readonly breaker?: CircuitBreaker;
  readonly idleTimeoutMs?: number;
  readonly apiVersion?: string;
}

function toAnthropicMessages(turns: readonly ProviderTurn[]): JsonObject[] {
  const messages: JsonObject[] = [];

  for (const turn of turns) {
    const content: JsonObject[] = [];
    if (turn.text !== "") content.push({ type: "text", text: turn.text });

    for (const call of turn.toolCalls ?? []) {
      content.push({
        type: "tool_use",
        id: call.toolCallId,
        name: call.toolName,
        input: parseArgumentsObject(call.argumentsJson),
      });
    }

    for (const result of turn.toolResults ?? []) {
      content.push({
        type: "tool_result",
        tool_use_id: result.toolCallId,
        content: result.content,
        is_error: result.isError,
      });
    }

    if (content.length > 0) messages.push({ role: turn.role, content });
  }

  return messages;
}

export function buildAnthropicBody(request: ProviderRequest): JsonObject {
  const body: JsonObject = {
    model: request.model.id,
    max_tokens:
      request.maxOutputTokens ?? Math.min(request.model.maxOutputTokens, DEFAULT_MAX_OUTPUT_TOKENS),
    system: request.systemPrompt,
    messages: toAnthropicMessages(request.turns),
    stream: true,
  };

  if (request.temperature !== undefined) body.temperature = request.temperature;

  if (request.tools.length > 0) {
    body.tools = request.tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      input_schema: tool.inputSchema as JsonValue,
    }));
  }

  return body;
}

function mapStopReason(reason: string): ProviderStopReason {
  switch (reason) {
    case "end_turn":
    case "stop_sequence":
      return "end_turn";
    case "tool_use":
      return "tool_use";
    case "max_tokens":
      return "max_tokens";
    case "refusal":
      return "content_filter";
    default:
      return "unknown";
  }
}

async function* streamAnthropic(
  config: AnthropicConfig,
  request: ProviderRequest,
  options: StreamOptions,
): AsyncGenerator<ProviderEvent> {
  const opened = await openProviderStream(
    {
      providerId: "anthropic",
      baseUrl: config.baseUrl ?? "https://api.anthropic.com/v1",
      headers: {
        "x-api-key": config.apiKey,
        "anthropic-version": config.apiVersion ?? ANTHROPIC_VERSION,
      },
      transport: config.transport,
      timeoutMs: config.timeoutMs,
      retryPolicy: config.retryPolicy,
      breaker: config.breaker,
    },
    {
      path: "/messages",
      body: JSON.stringify(buildAnthropicBody(request)),
      signal: options.signal,
    },
  );

  try {
    if (!opened.response.body) {
      throw new ProviderError("anthropic", "empty_stream", "Anthropic returned no body.");
    }

    let inputTokens = 0;
    let outputTokens = 0;
    let sawMessageStop = false;
    let stopReason: ProviderStopReason | undefined;
    const openToolBlocks = new Map<number, { readonly id: string; readonly name: string }>();

    for await (const frame of readSseFrames(
      opened.response.body,
      options.signal,
      config.idleTimeoutMs,
    )) {
      if (frame.data.trim() === "") continue;
      const payload = parseStreamPayload("anthropic", frame.data);
      const eventType = asString(payload.type) ?? frame.event ?? "";

      switch (eventType) {
        case "message_start": {
          const message = asRecord(payload.message);
          const usage = message === undefined ? undefined : asRecord(message.usage);
          inputTokens =
            (usage === undefined ? undefined : asNumber(usage.input_tokens)) ?? inputTokens;
          break;
        }

        case "content_block_start": {
          const index = asNumber(payload.index) ?? 0;
          const block = asRecord(payload.content_block);
          if (block === undefined || asString(block.type) !== "tool_use") break;

          const id = asString(block.id);
          const name = asString(block.name);
          if (id === undefined || name === undefined) {
            throw new ProviderError(
              "anthropic",
              "malformed_stream",
              "Anthropic tool_use block arrived without an id or name.",
            );
          }

          openToolBlocks.set(index, { id, name });
          yield { type: "tool_call_start", index, toolCallId: id, toolName: name };

          const initialInput = asRecord(block.input);
          if (initialInput !== undefined && Object.keys(initialInput).length > 0) {
            yield { type: "tool_call_arguments_delta", index, delta: JSON.stringify(initialInput) };
          }
          break;
        }

        case "content_block_delta": {
          const index = asNumber(payload.index) ?? 0;
          const delta = asRecord(payload.delta);
          const deltaType = delta === undefined ? undefined : asString(delta.type);

          if (deltaType === "text_delta") {
            const text = delta === undefined ? undefined : asString(delta.text);
            if (text !== undefined && text !== "") yield { type: "assistant_text_delta", text };
          } else if (deltaType === "thinking_delta") {
            const thinking = delta === undefined ? undefined : asString(delta.thinking);
            if (thinking !== undefined && thinking !== "") {
              yield { type: "thinking_delta", text: thinking };
            }
          } else if (deltaType === "input_json_delta") {
            const partial = delta === undefined ? undefined : asString(delta.partial_json);
            if (partial !== undefined && partial !== "") {
              yield { type: "tool_call_arguments_delta", index, delta: partial };
            }
          }
          break;
        }

        case "content_block_stop": {
          const index = asNumber(payload.index) ?? 0;
          if (openToolBlocks.delete(index)) yield { type: "tool_call_end", index };
          break;
        }

        case "message_delta": {
          const delta = asRecord(payload.delta);
          const reason = delta === undefined ? undefined : asString(delta.stop_reason);
          if (reason !== undefined) stopReason = mapStopReason(reason);

          const usage = asRecord(payload.usage);
          const reportedOutput = usage === undefined ? undefined : asNumber(usage.output_tokens);
          if (reportedOutput !== undefined) outputTokens = reportedOutput;
          break;
        }

        case "message_stop": {
          sawMessageStop = true;
          break;
        }

        case "error": {
          const errorPayload = asRecord(payload.error);
          throw new ProviderError(
            "anthropic",
            "provider_unavailable",
            (errorPayload === undefined ? undefined : asString(errorPayload.message)) ??
              "Anthropic reported an error mid-stream.",
          );
        }

        default:
          // `ping` and any future event types are safe to ignore.
          break;
      }
    }

    if (!sawMessageStop) {
      throw new ProviderError(
        "anthropic",
        "truncated_stream",
        "Anthropic closed the stream before message_stop.",
      );
    }

    const usage: TokenUsage = { inputTokens, outputTokens };
    yield { type: "usage", usage };

    yield {
      type: "completed",
      stopReason: stopReason ?? (openToolBlocks.size > 0 ? "tool_use" : "unknown"),
    };
  } finally {
    opened.release();
    const body = opened.response.body;
    if (body) {
      try {
        await body.cancel();
      } catch {
        // Body already consumed or closed.
      }
    }
  }
}

export function createAnthropicProvider(config: AnthropicConfig): LlmProvider {
  return {
    id: "anthropic",
    stream: (request, options) => streamAnthropic(config, request, options),
  };
}
