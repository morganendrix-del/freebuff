import type { ModelSelectionError, ModelSpec } from "../types/model";
import type { AgentTier } from "../types/tier";
import { tierAtLeast } from "../types/tier";
import type { Result } from "../utils/result";
import { err, ok } from "../utils/result";

/**
 * Model catalogue. Data, not logic: ops can override the whole catalogue from the environment
 * (`MODEL_CATALOG_JSON`) without touching code. Prices are USD per million tokens.
 */
export const DEFAULT_MODEL_CATALOG: readonly ModelSpec[] = [
  {
    id: "deepseek-chat",
    provider: "deepseek",
    displayName: "DeepSeek Chat",
    contextWindow: 131_072,
    maxOutputTokens: 8_192,
    capabilities: ["tools", "streaming", "prompt_caching"],
    pricing: { inputPerMTokUsd: 0.28, outputPerMTokUsd: 0.42, cachedInputPerMTokUsd: 0.028 },
    minimumTier: "free",
    supportsParallelToolCalls: true,
  },
  {
    id: "deepseek-reasoner",
    provider: "deepseek",
    displayName: "DeepSeek Reasoner",
    contextWindow: 131_072,
    maxOutputTokens: 32_768,
    capabilities: ["tools", "streaming", "reasoning"],
    pricing: { inputPerMTokUsd: 0.28, outputPerMTokUsd: 0.42 },
    minimumTier: "free",
    supportsParallelToolCalls: false,
  },
  {
    id: "gpt-5.1",
    provider: "openai",
    displayName: "OpenAI GPT-5.1",
    contextWindow: 400_000,
    maxOutputTokens: 128_000,
    capabilities: ["tools", "streaming", "vision", "reasoning", "prompt_caching"],
    pricing: { inputPerMTokUsd: 1.25, outputPerMTokUsd: 10, cachedInputPerMTokUsd: 0.125 },
    minimumTier: "pro",
    supportsParallelToolCalls: true,
  },
  {
    id: "claude-sonnet-4-5",
    provider: "anthropic",
    displayName: "Claude Sonnet 4.5",
    contextWindow: 200_000,
    maxOutputTokens: 64_000,
    capabilities: ["tools", "streaming", "vision", "reasoning", "prompt_caching"],
    pricing: { inputPerMTokUsd: 3, outputPerMTokUsd: 15, cachedInputPerMTokUsd: 0.3 },
    minimumTier: "pro",
    supportsParallelToolCalls: true,
  },
];

/** Which model each tier starts with, and the order to fall back through when one is unavailable. */
export interface TierModelPolicy {
  readonly tier: AgentTier;
  readonly defaultModelId: string;
  readonly fallbackOrder: readonly string[];
}

export const DEFAULT_TIER_MODEL_POLICY: Readonly<Record<AgentTier, TierModelPolicy>> = {
  free: {
    tier: "free",
    defaultModelId: "deepseek-chat",
    fallbackOrder: ["deepseek-chat", "deepseek-reasoner"],
  },
  pro: {
    tier: "pro",
    defaultModelId: "claude-sonnet-4-5",
    fallbackOrder: ["claude-sonnet-4-5", "gpt-5.1", "deepseek-chat"],
  },
};

export interface ModelCatalogOptions {
  readonly catalog?: readonly ModelSpec[];
  readonly policy?: Readonly<Record<AgentTier, TierModelPolicy>>;
}

export function findModel(
  modelId: string,
  catalog: readonly ModelSpec[] = DEFAULT_MODEL_CATALOG,
): ModelSpec | undefined {
  return catalog.find((model) => model.id === modelId);
}

export function modelsForTier(
  tier: AgentTier,
  options: ModelCatalogOptions = {},
): readonly ModelSpec[] {
  const catalog = options.catalog ?? DEFAULT_MODEL_CATALOG;
  return catalog.filter((model) => tierAtLeast(tier, model.minimumTier));
}

export function isModelAllowedForTier(
  modelId: string,
  tier: AgentTier,
  options: ModelCatalogOptions = {},
): boolean {
  const catalog = options.catalog ?? DEFAULT_MODEL_CATALOG;
  const model = findModel(modelId, catalog);
  return model !== undefined && tierAtLeast(tier, model.minimumTier);
}

/**
 * Resolves the model for a request from tier configuration. Never hardcode a model at a call site:
 * every entry point goes through here.
 */
export function resolveModelForTier(
  tier: AgentTier,
  requestedModelId?: string,
  options: ModelCatalogOptions = {},
): Result<ModelSpec, ModelSelectionError> {
  const catalog = options.catalog ?? DEFAULT_MODEL_CATALOG;
  const policy = options.policy ?? DEFAULT_TIER_MODEL_POLICY;
  const modelId = requestedModelId ?? policy[tier].defaultModelId;
  const model = findModel(modelId, catalog);

  if (!model) {
    return err({
      code: "unknown_model",
      message: `Unknown model "${modelId}".`,
      modelId,
      tier,
    });
  }

  if (!tierAtLeast(tier, model.minimumTier)) {
    return err({
      code: "tier_not_permitted",
      message: `Model "${modelId}" requires the ${model.minimumTier} tier.`,
      modelId,
      tier,
      requiredTier: model.minimumTier,
    });
  }

  return ok(model);
}
