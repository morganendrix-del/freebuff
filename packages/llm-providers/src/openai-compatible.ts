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
  StreamOptions,
  Transport,
} from "./types";
import { asArray, asNumber, asRecord, asString, parseStreamPayload } from "./wire";

export interface OpenAiCompatibleConfig {
  readonly providerId: "deepseek" | "openai";
  readonly apiKey: string;
  readonly baseUrl: string;
  readonly path?: string;
  readonly transport?: Transport;
  readonly timeoutMs?: number;
  readonly retryPolicy?: RetryPolicy;
  readonly breaker?: CircuitBreaker;
  readonly extraHeaders?: Readonly<Record<string, string>>;
  readonly idleTimeoutMs?: number;
}

function toMessages(request: ProviderRequest): JsonObject[] {
  const messages: JsonObject[] = [{ role: "system", content: request.systemPrompt }];

  for (const turn of request.turns) {
    if (turn.role === "assistant") {
      const message: JsonObject = {
        role: "assistant",
        content: turn.text === "" ? null : turn.text,
      };
      if (turn.toolCalls !== undefined && turn.toolCalls.length > 0) {
        message.tool_calls = turn.toolCalls.map((call) => ({
          id: call.toolCallId,
          type: "function",
          function: { name: call.toolName, arguments: call.argumentsJson },
        }));
      }
      messages.push(message);
      continue;
    }

    if (turn.text !== "") messages.push({ role: "user", content: turn.text });
    for (const result of turn.toolResults ?? []) {
      messages.push({ role: "tool", tool_call_id: result.toolCallId, content: result.content });
    }
  }

  return messages;
}

export function buildOpenAiCompatibleBody(request: ProviderRequest): JsonObject {
  const body: JsonObject = {
    model: request.model.id,
    messages: toMessages(request),
    stream: true,
    stream_options: { include_usage: true },
    max_tokens: request.maxOutputTokens ?? request.model.maxOutputTokens,
  };

  if (request.temperature !== undefined) body.temperature = request.temperature;

  if (request.tools.length > 0) {
    body.tools = request.tools.map((tool) => ({
      type: "function",
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.inputSchema as JsonValue,
      },
    }));
    body.parallel_tool_calls = request.model.supportsParallelToolCalls;
  }

  return body;
}

function mapFinishReason(reason: string): ProviderStopReason {
  switch (reason) {
    case "stop":
      return "end_turn";
    case "tool_calls":
    case "function_call":
      return "tool_use";
    case "length":
      return "max_tokens";
    case "content_filter":
      return "content_filter";
    default:
      return "unknown";
  }
}

function readUsage(usage: JsonObject): TokenUsage | undefined {
  const inputTokens = asNumber(usage.prompt_tokens);
  const outputTokens = asNumber(usage.completion_tokens);
  if (inputTokens === undefined || outputTokens === undefined) return undefined;

  const cachedInputTokens = asNumber(asRecord(usage.prompt_tokens_details)?.cached_tokens);
  return {
    inputTokens,
    outputTokens,
    ...(cachedInputTokens === undefined ? {} : { cachedInputTokens }),
  };
}

async function* streamOpenAiCompatible(
  config: OpenAiCompatibleConfig,
  request: ProviderRequest,
  options: StreamOptions,
): AsyncGenerator<ProviderEvent> {
  const opened = await openProviderStream(
    {
      providerId: config.providerId,
      baseUrl: config.baseUrl,
      headers: {
        authorization: `Bearer ${config.apiKey}`,
        ...config.extraHeaders,
      },
      transport: config.transport,
      timeoutMs: config.timeoutMs,
      retryPolicy: config.retryPolicy,
      breaker: config.breaker,
    },
    {
      path: config.path ?? "/chat/completions",
      body: JSON.stringify(buildOpenAiCompatibleBody(request)),
      signal: options.signal,
    },
  );

  try {
    if (!opened.response.body) {
      throw new ProviderError(config.providerId, "empty_stream", "Provider returned no body.");
    }

    const calls = new Map<number, { toolCallId: string; toolName: string }>();
    let stopReason: ProviderStopReason | undefined;
    let sawDone = false;
    let sawFinish = false;

    for await (const frame of readSseFrames(
      opened.response.body,
      options.signal,
      config.idleTimeoutMs,
    )) {
      const data = frame.data.trim();
      if (data === "") continue;
      if (data === "[DONE]") {
        sawDone = true;
        break;
      }

      const payload = parseStreamPayload(config.providerId, data);

      const errorPayload = asRecord(payload.error);
      if (errorPayload) {
        throw new ProviderError(
          config.providerId,
          "provider_unavailable",
          asString(errorPayload.message) ?? `${config.providerId} reported an error mid-stream.`,
        );
      }

      const usagePayload = asRecord(payload.usage);
      if (usagePayload) {
        const usage = readUsage(usagePayload);
        if (usage) yield { type: "usage", usage };
      }

      const choices = asArray(payload.choices);
      const choice = choices === undefined ? undefined : asRecord(choices[0]);
      if (!choice) continue;

      const delta = asRecord(choice.delta);
      if (delta) {
        const text = asString(delta.content);
        if (text !== undefined && text !== "") yield { type: "assistant_text_delta", text };

        const thinking = asString(delta.reasoning_content);
        if (thinking !== undefined && thinking !== "")
          yield { type: "thinking_delta", text: thinking };

        for (const rawCall of asArray(delta.tool_calls) ?? []) {
          const call = asRecord(rawCall);
          if (!call) continue;

          const index = asNumber(call.index) ?? 0;
          const fn = asRecord(call.function);
          const name = fn === undefined ? undefined : asString(fn.name);
          const argumentsDelta = fn === undefined ? undefined : asString(fn.arguments);

          if (!calls.has(index)) {
            const toolCallId = asString(call.id);
            if (toolCallId === undefined || name === undefined || name === "") {
              throw new ProviderError(
                config.providerId,
                "malformed_stream",
                "Tool call chunk arrived without an id or name.",
              );
            }
            calls.set(index, { toolCallId, toolName: name });
            yield { type: "tool_call_start", index, toolCallId, toolName: name };
          }

          if (argumentsDelta !== undefined && argumentsDelta !== "") {
            yield { type: "tool_call_arguments_delta", index, delta: argumentsDelta };
          }
        }
      }

      const finishReason = asString(choice.finish_reason);
      if (finishReason !== undefined && finishReason !== "") {
        sawFinish = true;
        stopReason = mapFinishReason(finishReason);
      }
    }

    if (!sawDone && !sawFinish) {
      throw new ProviderError(
        config.providerId,
        "truncated_stream",
        `${config.providerId} closed the stream before reporting a finish reason.`,
      );
    }

    for (const index of [...calls.keys()].sort((left, right) => left - right)) {
      yield { type: "tool_call_end", index };
    }

    yield {
      type: "completed",
      stopReason: stopReason ?? (calls.size > 0 ? "tool_use" : "unknown"),
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

export function createOpenAiCompatibleProvider(config: OpenAiCompatibleConfig): LlmProvider {
  return {
    id: config.providerId,
    stream: (request, options) => streamOpenAiCompatible(config, request, options),
  };
}
