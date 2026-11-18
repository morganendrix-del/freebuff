import { DEFAULT_PROVIDER_ENDPOINTS } from "@freebuff/shared";

import { createOpenAiCompatibleProvider } from "./openai-compatible";
import type { LlmProvider, ProviderFactoryOptions } from "./types";

export function createDeepSeekProvider(options: ProviderFactoryOptions): LlmProvider {
  return createOpenAiCompatibleProvider({
    providerId: "deepseek",
    apiKey: options.apiKey,
    baseUrl: options.baseUrl ?? DEFAULT_PROVIDER_ENDPOINTS.deepseek.baseUrl,
    path: "/chat/completions",
    ...(options.transport === undefined ? {} : { transport: options.transport }),
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    ...(options.retryPolicy === undefined ? {} : { retryPolicy: options.retryPolicy }),
    ...(options.breaker === undefined ? {} : { breaker: options.breaker }),
  });
}
