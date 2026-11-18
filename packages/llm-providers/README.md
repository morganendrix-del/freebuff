# @freebuff/llm-providers

Status: **implemented** (Phase 1).

Streaming provider shims for DeepSeek (free default), OpenAI and Anthropic behind one interface. Model
choice comes from `resolveModelForTier` in `packages/shared/src/config/models.ts`; no call site names a
model directly, and a lint rule enforces it.

## Modules

| Module                 | Responsibility                                                                       |
| ---------------------- | ------------------------------------------------------------------------------------ |
| `types.ts`             | `LlmProvider`, `ProviderEvent`, `Transport`, factory options                         |
| `sse.ts`               | Incremental SSE reader: multi-line `data:`, comment/keepalive lines, abort-aware     |
| `transport.ts`         | HTTP client applying timeout, retry with jittered backoff and the shared breaker     |
| `openai-compatible.ts` | Chat Completions mapping shared by DeepSeek and OpenAI                               |
| `deepseek.ts`          | `https://api.deepseek.com` adapter                                                   |
| `openai.ts`            | `https://api.openai.com/v1` adapter, gateway `baseUrl` override                      |
| `anthropic.ts`         | Messages adapter: system prompt, `tool_use`/`tool_result` blocks, `x-api-key` auth   |
| `wire.ts`              | Wire-format guards for provider payloads                                             |
| `errors.ts`            | `ProviderError` codes: rate limit, unavailable, credentials, malformed/truncated     |
| `index.ts`             | `createProvider`, `createProviderFromEnv` (keys come from validated env, never code) |

## Behaviour

- 2xx responses stream `assistant_text_delta`, `tool_call_start` / `tool_call_arguments_delta` /
  `tool_call_end`, `usage`, then `completed` with a stop reason.
- 429 and 5xx are retried up to `maxAttempts`; exhaustion raises `RetryExhaustedError` carrying a
  retryable `ProviderError`. 401 is never retried.
- A stream that ends without its terminal event (`[DONE]`, `message_stop`) is a `truncated_stream`
  failure, not a silent success.
- Cancellation rejects with `cancelled` and closes the response body.

## Tests

`packages/llm-providers/test/*.test.ts` — 22 recorded-HTTP tests over three shims, including 429 retry,
repeated 5xx/529 exhaustion, 401 no-retry, timeout, truncated and malformed streams, and in-flight
cancellation.
