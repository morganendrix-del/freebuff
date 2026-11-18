import { createProvider } from "@freebuff/llm-providers";
import { PROVIDER_API_KEY_ENV } from "@freebuff/shared";
import type { ProviderId } from "@freebuff/shared";
import type { LlmProvider } from "@freebuff/llm-providers";

/**
 * Builds a provider from the environment. The key name comes from shared config, so the CLI never
 * mentions a provider-specific variable by hand and no key is ever written to disk or logs.
 */
export function createCliProvider(
  providerId: ProviderId,
  env: Readonly<Record<string, string | undefined>> = process.env,
): LlmProvider {
  const keyName = PROVIDER_API_KEY_ENV[providerId];
  const apiKey = env[keyName];
  if (apiKey === undefined || apiKey.trim() === "") {
    throw new Error(`${keyName} is not set, so the ${providerId} provider cannot run.`);
  }
  return createProvider(providerId, { apiKey });
}
