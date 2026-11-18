import { RetryExhaustedError, TimeoutError } from "@freebuff/shared";
import { describe, expect, test } from "vitest";

import { createOpenAiProvider } from "../src/openai";
import { OPENAI_TEXT_SSE } from "./fixtures";
import {
  FAST_RETRY,
  SINGLE_ATTEMPT,
  collect,
  createRecordingTransport,
  fixtureRequest,
} from "./recorded";

const signal = (): AbortSignal => new AbortController().signal;

describe("OpenAI shim", () => {
  test("uses the OpenAI endpoint and streams text plus cached usage", async () => {
    const { transport, requests } = createRecordingTransport([{ body: OPENAI_TEXT_SSE }]);
    const provider = createOpenAiProvider({
      apiKey: "sk-openai",
      transport,
      retryPolicy: FAST_RETRY,
    });

    const events = await collect(provider.stream(fixtureRequest(), { signal: signal() }));

    expect(events).toEqual([
      { type: "assistant_text_delta", text: "Hi" },
      { type: "usage", usage: { inputTokens: 7, outputTokens: 1, cachedInputTokens: 5 } },
      { type: "completed", stopReason: "end_turn" },
    ]);
    expect(requests[0]?.url).toBe("https://api.openai.com/v1/chat/completions");
    expect(requests[0]?.headers.authorization).toBe("Bearer sk-openai");
  });

  test("honours a gateway base URL override", async () => {
    const { transport, requests } = createRecordingTransport([{ body: OPENAI_TEXT_SSE }]);
    const provider = createOpenAiProvider({
      apiKey: "sk-openai",
      baseUrl: "https://gateway.internal/v1/",
      transport,
      retryPolicy: FAST_RETRY,
    });

    await collect(provider.stream(fixtureRequest(), { signal: signal() }));
    expect(requests[0]?.url).toBe("https://gateway.internal/v1/chat/completions");
  });

  test("retries a 429 and succeeds on the next attempt", async () => {
    const { transport, requests } = createRecordingTransport([
      { status: 429, body: "{}" },
      { body: OPENAI_TEXT_SSE },
    ]);
    const provider = createOpenAiProvider({
      apiKey: "sk-openai",
      transport,
      retryPolicy: FAST_RETRY,
    });

    const events = await collect(provider.stream(fixtureRequest(), { signal: signal() }));
    expect(requests).toHaveLength(2);
    expect(events.at(-1)).toEqual({ type: "completed", stopReason: "end_turn" });
  });

  test("gives up on repeated 5xx with a retryable provider error", async () => {
    const { transport, requests } = createRecordingTransport([{ status: 503, body: "{}" }]);
    const provider = createOpenAiProvider({
      apiKey: "sk-openai",
      transport,
      retryPolicy: FAST_RETRY,
    });

    const failure = collect(provider.stream(fixtureRequest(), { signal: signal() }));
    await expect(failure).rejects.toBeInstanceOf(RetryExhaustedError);
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

    const provider = createOpenAiProvider({
      apiKey: "sk-openai",
      transport: hangingTransport,
      timeoutMs: 10,
      retryPolicy: SINGLE_ATTEMPT,
    });

    await expect(
      collect(provider.stream(fixtureRequest(), { signal: signal() })),
    ).rejects.toBeInstanceOf(TimeoutError);
  });
});
