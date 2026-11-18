import type { ProviderId } from "../types/model";
import type { PlatformEnv } from "./env";

export interface ProviderEndpoint {
  readonly baseUrl: string;
  /** DeepSeek also exposes an Anthropic-format endpoint; records it so shims stay data-driven. */
  readonly anthropicCompatibleBaseUrl?: string;
}

export const DEFAULT_PROVIDER_ENDPOINTS: Readonly<Record<ProviderId, ProviderEndpoint>> = {
  deepseek: {
    baseUrl: "https://api.deepseek.com",
    anthropicCompatibleBaseUrl: "https://api.deepseek.com/anthropic",
  },
  openai: { baseUrl: "https://api.openai.com/v1" },
  anthropic: { baseUrl: "https://api.anthropic.com/v1" },
};

export const PROVIDER_API_KEY_ENV: Readonly<Record<ProviderId, keyof PlatformEnv>> = {
  deepseek: "DEEPSEEK_API_KEY",
  openai: "OPENAI_API_KEY",
  anthropic: "ANTHROPIC_API_KEY",
};

export const PROVIDER_BASE_URL_ENV: Readonly<Record<ProviderId, keyof PlatformEnv>> = {
  deepseek: "DEEPSEEK_BASE_URL",
  openai: "OPENAI_BASE_URL",
  anthropic: "ANTHROPIC_BASE_URL",
};

/** Endpoint for a provider, honouring a deployment override (proxy, gateway, self-hosted). */
export function resolveProviderBaseUrl(provider: ProviderId, env?: Partial<PlatformEnv>): string {
  const override = env?.[PROVIDER_BASE_URL_ENV[provider]];
  if (typeof override === "string" && override !== "") return override;
  return DEFAULT_PROVIDER_ENDPOINTS[provider].baseUrl;
}
