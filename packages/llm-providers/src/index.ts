import {
  ConfigurationError,
  PROVIDER_API_KEY_ENV,
  PROVIDER_BASE_URL_ENV,
  resolveProviderBaseUrl,
} from "@freebuff/shared";
import type { PlatformEnv, ProviderId } from "@freebuff/shared";

import { createAnthropicProvider } from "./anthropic";
import { createDeepSeekProvider } from "./deepseek";
import { createOpenAiProvider } from "./openai";
import type { LlmProvider, ProviderFactoryOptions } from "./types";

export * from "./anthropic";
export * from "./deepseek";
export * from "./errors";
export * from "./openai";
export * from "./openai-compatible";
export * from "./sse";
export * from "./transport";
export * from "./types";
export * from "./wire";

export function createProvider(
  providerId: ProviderId,
  options: ProviderFactoryOptions,
): LlmProvider {
  switch (providerId) {
    case "anthropic":
      return createAnthropicProvider({
        apiKey: options.apiKey,
        ...(options.baseUrl === undefined ? {} : { baseUrl: options.baseUrl }),
        ...(options.transport === undefined ? {} : { transport: options.transport }),
        ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
        ...(options.retryPolicy === undefined ? {} : { retryPolicy: options.retryPolicy }),
        ...(options.breaker === undefined ? {} : { breaker: options.breaker }),
      });
    case "deepseek":
      return createDeepSeekProvider(options);
    case "openai":
      return createOpenAiProvider(options);
  }
}

export type ProviderOverrides = Omit<ProviderFactoryOptions, "apiKey" | "baseUrl">;

/** Builds a provider from validated platform environment. Keys never leave the process. */
export function createProviderFromEnv(
  providerId: ProviderId,
  env: PlatformEnv,
  overrides: ProviderOverrides = {},
): LlmProvider {
  const keyName = PROVIDER_API_KEY_ENV[providerId];
  const apiKey = env[keyName];
  if (typeof apiKey !== "string" || apiKey === "") {
    throw new ConfigurationError(
      `Missing ${keyName}: the ${providerId} provider cannot be used without it.`,
    );
  }

  const baseUrlOverride = env[PROVIDER_BASE_URL_ENV[providerId]];
  return createProvider(providerId, {
    ...overrides,
    apiKey,
    baseUrl:
      typeof baseUrlOverride === "string" && baseUrlOverride !== ""
        ? baseUrlOverride
        : resolveProviderBaseUrl(providerId, env),
  });
}
