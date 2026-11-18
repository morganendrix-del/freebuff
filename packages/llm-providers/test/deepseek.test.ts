import { RetryExhaustedError, TimeoutError } from "@freebuff/shared";
import { describe, expect, test } from "vitest";

import { ProviderError } from "../src/errors";
import { createDeepSeekProvider } from "../src/deepseek";
import {
  DEEPSEEK_MALFORMED_SSE,
  DEEPSEEK_TEXT_SSE,
  DEEPSEEK_TOOL_SSE,
  DEEPSEEK_TRUNCATED_SSE,
} from "./fixtures";
import {
  FAST_RETRY,
  SINGLE_ATTEMPT,
  collect,
  createRecordingTransport,
  fixtureRequest,
} from "./recorded";

const signal = (): AbortSignal => new AbortController().signal;

describe("DeepSeek shim", () => {
  test("maps the request to Chat Completions and streams text with usage", async () => {
    const { transport, requests } = createRecordingTransport([{ body: DEEPSEEK_TEXT_SSE }]);
    const provider = createDeepSeekProvider({
      apiKey: "sk-test",
      transport,
      retryPolicy: FAST_RETRY,
    });

    const events = await collect(provider.stream(fixtureRequest(), { signal: signal() }));

    expect(events).toEqual([
      { type: "assistant_text_delta", text: "Hello" },
      { type: "assistant_text_delta", text: " world" },
      { type: "usage", usage: { inputTokens: 11, outputTokens: 2 } },
      { type: "completed", stopReason: "end_turn" },
    ]);

    const request = requests[0];
    expect(request?.url).toBe("https://api.deepseek.com/chat/completions");
    expect(request?.headers.authorization).toBe("Bearer sk-test");

    const body = JSON.parse(request?.body ?? "{}") as Record<string, unknown>;
    expect(body.model).toBe("deepseek-flash");
    expect(body.stream).toBe(true);
    expect(body.messages).toEqual([
      { role: "system", content: "You are a coding agent." },
      { role: "user", content: "Fix the add function." },
    ]);
    expect(body.tools).toHaveLength(1);
  });

  test("assembles streamed tool-call fragments in order", async () => {
    const { transport } = createRecordingTransport([{ body: DEEPSEEK_TOOL_SSE }]);
    const provider = createDeepSeekProvider({
      apiKey: "sk-test",
      transport,
      retryPolicy: FAST_RETRY,
    });

    const events = await collect(provider.stream(fixtureRequest(), { signal: signal() }));

    expect(events).toContainEqual({ type: "thinking_delta", text: "I should read the file." });
    expect(events).toContainEqual({
      type: "tool_call_start",
      index: 0,
      toolCallId: "call_1",
      toolName: "read_file",
    });
    expect(events).toContainEqual({
      type: "tool_call_arguments_delta",
      index: 0,
      delta: '{"path":',
    });
    expect(events).toContainEqual({
      type: "tool_call_arguments_delta",
      index: 0,
      delta: '"src/add.ts"}',
    });
    expect(events).toContainEqual({ type: "tool_call_end", index: 0 });
    expect(events.at(-1)).toEqual({ type: "completed", stopReason: "tool_use" });

    const argumentText = events
      .filter((event) => event.type === "tool_call_arguments_delta")
      .map((event) => event.delta)
      .join("");
    expect(JSON.parse(argumentText)).toEqual({ path: "src/add.ts" });
  });

  test("retries a 429 and succeeds on the next attempt", async () => {
    const { transport, requests } = createRecordingTransport([
      { status: 429, body: "{}" },
      { body: DEEPSEEK_TEXT_SSE },
    ]);
    const provider = createDeepSeekProvider({
      apiKey: "sk-test",
      transport,
      retryPolicy: FAST_RETRY,
    });

    const events = await collect(provider.stream(fixtureRequest(), { signal: signal() }));

    expect(requests).toHaveLength(2);
    expect(events.at(-1)).toEqual({ type: "completed", stopReason: "end_turn" });
  });

  test("gives up on repeated 5xx with a retryable provider error", async () => {
    const { transport, requests } = createRecordingTransport([{ status: 503, body: "{}" }]);
    const provider = createDeepSeekProvider({
      apiKey: "sk-test",
      transport,
      retryPolicy: FAST_RETRY,
    });

    const failure = collect(provider.stream(fixtureRequest(), { signal: signal() }));
    await expect(failure).rejects.toBeInstanceOf(RetryExhaustedError);
    expect(requests).toHaveLength(3);

    const error = await failure.catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(RetryExhaustedError);
    if (!(error instanceof RetryExhaustedError)) throw new Error("expected retry exhaustion");
    expect(error.lastError).toBeInstanceOf(ProviderError);
    expect((error.lastError as ProviderError).code).toBe("provider_unavailable");
    expect((error.lastError as ProviderError).retryable).toBe(true);
  });

  test("does not retry invalid credentials", async () => {
    const { transport, requests } = createRecordingTransport([{ status: 401, body: "{}" }]);
    const provider = createDeepSeekProvider({
      apiKey: "sk-bad",
      transport,
      retryPolicy: FAST_RETRY,
    });

    const failure = collect(provider.stream(fixtureRequest(), { signal: signal() }));
    await expect(failure).rejects.toBeInstanceOf(ProviderError);
    expect(requests).toHaveLength(1);

    const error = await failure.catch((reason: unknown) => reason);
    expect(error).toMatchObject({ code: "invalid_credentials", retryable: false, status: 401 });
  });

  test("times out when the provider never responds", async () => {
    const hangingTransport = ({ signal: transportSignal }: { signal: AbortSignal }) =>
      new Promise<Response>((_resolve, reject) => {
        transportSignal.addEventListener(
          "abort",
          () => {
            reject(new DOMException("The operation was aborted.", "AbortError"));
          },
          { once: true },
        );
      });

    const provider = createDeepSeekProvider({
      apiKey: "sk-test",
      transport: hangingTransport,
      timeoutMs: 10,
      retryPolicy: SINGLE_ATTEMPT,
    });

    await expect(
      collect(provider.stream(fixtureRequest(), { signal: signal() })),
    ).rejects.toBeInstanceOf(TimeoutError);
  });

  test("rejects a truncated stream instead of pretending it finished", async () => {
    const { transport } = createRecordingTransport([{ body: DEEPSEEK_TRUNCATED_SSE }]);
    const provider = createDeepSeekProvider({
      apiKey: "sk-test",
      transport,
      retryPolicy: FAST_RETRY,
    });

    await expect(
      collect(provider.stream(fixtureRequest(), { signal: signal() })),
    ).rejects.toMatchObject({ code: "truncated_stream" });
  });

  test("rejects malformed stream JSON", async () => {
    const { transport } = createRecordingTransport([{ body: DEEPSEEK_MALFORMED_SSE }]);
    const provider = createDeepSeekProvider({
      apiKey: "sk-test",
      transport,
      retryPolicy: FAST_RETRY,
    });

    const failure = collect(provider.stream(fixtureRequest(), { signal: signal() }));
    await expect(failure).rejects.toBeInstanceOf(ProviderError);

    const error = await failure.catch((reason: unknown) => reason);
    expect(error).toMatchObject({ code: "malformed_stream" });
  });

  test("aborts an in-flight stream when the caller cancels", async () => {
    const { transport } = createRecordingTransport([{ body: DEEPSEEK_TEXT_SSE }]);
    const provider = createDeepSeekProvider({
      apiKey: "sk-test",
      transport,
      retryPolicy: FAST_RETRY,
    });
    const controller = new AbortController();
    controller.abort();

    await expect(
      collect(provider.stream(fixtureRequest(), { signal: controller.signal })),
    ).rejects.toMatchObject({ code: "cancelled" });
  });
});
