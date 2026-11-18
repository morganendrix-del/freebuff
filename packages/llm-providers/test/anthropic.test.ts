import { RetryExhaustedError, TimeoutError } from "@freebuff/shared";
import { describe, expect, test } from "vitest";

import { ANTHROPIC_VERSION, createAnthropicProvider } from "../src/anthropic";
import { ProviderError } from "../src/errors";
import { ANTHROPIC_TEXT_SSE, ANTHROPIC_TOOL_SSE, ANTHROPIC_TRUNCATED_SSE } from "./fixtures";
import {
  FAST_RETRY,
  SINGLE_ATTEMPT,
  collect,
  createRecordingTransport,
  fixtureRequest,
} from "./recorded";

const signal = (): AbortSignal => new AbortController().signal;

describe("Anthropic shim", () => {
  test("maps the request to Messages and streams text with usage", async () => {
    const { transport, requests } = createRecordingTransport([{ body: ANTHROPIC_TEXT_SSE }]);
    const provider = createAnthropicProvider({
      apiKey: "sk-ant",
      transport,
      retryPolicy: FAST_RETRY,
    });

    const events = await collect(
      provider.stream(
        fixtureRequest({ model: { ...fixtureRequest().model, id: "claude-sonnet-5-5" } }),
        {
          signal: signal(),
        },
      ),
    );

    expect(events).toEqual([
      { type: "assistant_text_delta", text: "Hi" },
      { type: "usage", usage: { inputTokens: 11, outputTokens: 2 } },
      { type: "completed", stopReason: "end_turn" },
    ]);

    const request = requests[0];
    expect(request?.url).toBe("https://api.anthropic.com/v1/messages");
    expect(request?.headers["x-api-key"]).toBe("sk-ant");
    expect(request?.headers["anthropic-version"]).toBe(ANTHROPIC_VERSION);
    expect(request?.headers.authorization).toBeUndefined();

    const body = JSON.parse(request?.body ?? "{}") as Record<string, unknown>;
    expect(body.system).toBe("You are a coding agent.");
    expect(body.max_tokens).toBe(8192);
    expect(body.messages).toEqual([
      { role: "user", content: [{ type: "text", text: "Fix the add function." }] },
    ]);
    expect(body.tools).toEqual([
      {
        name: "read_file",
        description: "Read a file from the workspace",
        input_schema: {
          type: "object",
          properties: { path: { type: "string" } },
          required: ["path"],
        },
      },
    ]);
  });

  test("normalises tool_use blocks into the shared event shape", async () => {
    const { transport } = createRecordingTransport([{ body: ANTHROPIC_TOOL_SSE }]);
    const provider = createAnthropicProvider({
      apiKey: "sk-ant",
      transport,
      retryPolicy: FAST_RETRY,
    });

    const events = await collect(provider.stream(fixtureRequest(), { signal: signal() }));

    expect(events).toContainEqual({ type: "assistant_text_delta", text: "Reading it." });
    expect(events).toContainEqual({
      type: "tool_call_start",
      index: 1,
      toolCallId: "toolu_1",
      toolName: "read_file",
    });
    expect(events).toContainEqual({
      type: "tool_call_arguments_delta",
      index: 1,
      delta: '{"path":"src/add.ts"}',
    });
    expect(events).toContainEqual({ type: "tool_call_end", index: 1 });
    expect(events).toContainEqual({ type: "usage", usage: { inputTokens: 18, outputTokens: 9 } });
    expect(events.at(-1)).toEqual({ type: "completed", stopReason: "tool_use" });
  });

  test("retries 529 overload then streams", async () => {
    const { transport, requests } = createRecordingTransport([
      { status: 529, body: "{}" },
      { body: ANTHROPIC_TEXT_SSE },
    ]);
    const provider = createAnthropicProvider({
      apiKey: "sk-ant",
      transport,
      retryPolicy: FAST_RETRY,
    });

    await collect(provider.stream(fixtureRequest(), { signal: signal() }));
    expect(requests).toHaveLength(2);
  });

  test("rejects a stream that ends without message_stop", async () => {
    const { transport } = createRecordingTransport([{ body: ANTHROPIC_TRUNCATED_SSE }]);
    const provider = createAnthropicProvider({
      apiKey: "sk-ant",
      transport,
      retryPolicy: FAST_RETRY,
    });

    await expect(
      collect(provider.stream(fixtureRequest(), { signal: signal() })),
    ).rejects.toMatchObject({ code: "truncated_stream" });
  });

  test("surfaces an error event as a provider failure", async () => {
    const errorSse = `event: error
data: {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}

`;
    const { transport } = createRecordingTransport([{ body: errorSse }]);
    const provider = createAnthropicProvider({
      apiKey: "sk-ant",
      transport,
      retryPolicy: FAST_RETRY,
    });

    const failure = collect(provider.stream(fixtureRequest(), { signal: signal() }));
    await expect(failure).rejects.toBeInstanceOf(ProviderError);

    const error = await failure.catch((reason: unknown) => reason);
    expect(error).toMatchObject({ code: "provider_unavailable" });
  });

  test("exhausts retries on repeated rate limiting", async () => {
    const { transport } = createRecordingTransport([{ status: 429, body: "{}" }]);
    const provider = createAnthropicProvider({
      apiKey: "sk-ant",
      transport,
      retryPolicy: FAST_RETRY,
    });

    await expect(
      collect(provider.stream(fixtureRequest(), { signal: signal() })),
    ).rejects.toBeInstanceOf(RetryExhaustedError);
  });

  test("exhausts retries on repeated 5xx", async () => {
    const { transport, requests } = createRecordingTransport([{ status: 500, body: "{}" }]);
    const provider = createAnthropicProvider({
      apiKey: "sk-ant",
      transport,
      retryPolicy: FAST_RETRY,
    });

    await expect(
      collect(provider.stream(fixtureRequest(), { signal: signal() })),
    ).rejects.toBeInstanceOf(RetryExhaustedError);
    expect(requests).toHaveLength(FAST_RETRY.maxAttempts);
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

    const provider = createAnthropicProvider({
      apiKey: "sk-ant",
      transport: hangingTransport,
      timeoutMs: 10,
      retryPolicy: SINGLE_ATTEMPT,
    });

    await expect(
      collect(provider.stream(fixtureRequest(), { signal: signal() })),
    ).rejects.toBeInstanceOf(TimeoutError);
  });
});
