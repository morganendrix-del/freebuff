import type { ModelSelectionError, ModelSpec } from "../types/model";
import type { AgentTier } from "../types/tier";
import { tierAtLeast } from "../types/tier";
import type { Result } from "../utils/result";
import { err, ok } from "../utils/result";

/**
 * Model catalogue. Data, not logic: ops can override the whole catalogue from the environment
 * (`MODEL_CATALOG_JSON`) without touching code.
 *
 * Prices are USD per million tokens, standard tier. DeepSeek bills peak and off-peak rates, so both
 * are recorded and the peak rate is the headline (conservative) figure.
 */
export const MODEL_CATALOG_METADATA = {
  retrievedAt: "2026-11-17",
  sources: [
    "https://api-docs.deepseek.com/quick_start/pricing",
    "https://api-docs.deepseek.com/api/create-chat-completion/",
    "https://developers.openai.com/api/docs/pricing",
    "https://developers.openai.com/api/docs/models/gpt-6-astra",
    "https://docs.anthropic.com/en/docs/about-claude/pricing",
    "https://platform.claude.com/docs/en/models/sonnet-5-5/overview",
  ],
} as const;

export const DEFAULT_MODEL_CATALOG: readonly ModelSpec[] = [
  {
    id: "deepseek-flash",
    provider: "deepseek",
    displayName: "DeepSeek V4.1 Flash",
    contextWindow: 1_000_000,
    maxOutputTokens: 393_216,
    capabilities: ["tools", "streaming", "vision", "reasoning", "prompt_caching"],
    pricing: {
      inputPerMTokUsd: 0.3,
      outputPerMTokUsd: 1.2,
      cachedInputPerMTokUsd: 0.006,
      offPeakInputPerMTokUsd: 0.15,
      offPeakOutputPerMTokUsd: 0.6,
    },
    minimumTier: "free",
    supportsParallelToolCalls: true,
  },
  {
    id: "deepseek-v4-pro",
    provider: "deepseek",
    displayName: "DeepSeek V4 Pro",
    contextWindow: 1_000_000,
    maxOutputTokens: 393_216,
    capabilities: ["tools", "streaming", "reasoning", "prompt_caching"],
    pricing: {
      inputPerMTokUsd: 1.32,
      outputPerMTokUsd: 3.96,
      cachedInputPerMTokUsd: 0.044,
      offPeakInputPerMTokUsd: 0.66,
      offPeakOutputPerMTokUsd: 1.98,
    },
    minimumTier: "pro",
    supportsParallelToolCalls: true,
  },
  {
    id: "claude-sonnet-5-5",
    provider: "anthropic",
    displayName: "Claude Sonnet 5.5",
    contextWindow: 1_048_576,
    maxOutputTokens: 128_000,
    capabilities: ["tools", "streaming", "vision", "reasoning", "prompt_caching"],
    pricing: { inputPerMTokUsd: 2, outputPerMTokUsd: 10, cachedInputPerMTokUsd: 0.1 },
    minimumTier: "pro",
    supportsParallelToolCalls: true,
  },
  {
    id: "claude-opus-5-5",
    provider: "anthropic",
    displayName: "Claude Opus 5.5",
    contextWindow: 1_048_576,
    maxOutputTokens: 128_000,
    capabilities: ["tools", "streaming", "vision", "reasoning", "prompt_caching"],
    pricing: { inputPerMTokUsd: 4, outputPerMTokUsd: 20, cachedInputPerMTokUsd: 0.2 },
    minimumTier: "pro",
    supportsParallelToolCalls: true,
  },
  {
    id: "gpt-6.1-sol",
    provider: "openai",
    displayName: "OpenAI GPT-6.1 Sol",
    contextWindow: 1_050_000,
    maxOutputTokens: 128_000,
    capabilities: ["tools", "streaming", "vision", "reasoning", "prompt_caching"],
    pricing: { inputPerMTokUsd: 2, outputPerMTokUsd: 10, cachedInputPerMTokUsd: 0.1 },
    minimumTier: "pro",
    supportsParallelToolCalls: true,
  },
  {
    id: "gpt-6-astra",
    provider: "openai",
    displayName: "OpenAI GPT-6 Astra",
    contextWindow: 1_050_000,
    maxOutputTokens: 128_000,
    capabilities: ["tools", "streaming", "vision", "reasoning", "prompt_caching"],
    pricing: { inputPerMTokUsd: 10, outputPerMTokUsd: 50, cachedInputPerMTokUsd: 1 },
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
    defaultModelId: "deepseek-flash",
    fallbackOrder: ["deepseek-flash"],
  },
  pro: {
    tier: "pro",
    defaultModelId: "claude-sonnet-5-5",
    fallbackOrder: ["claude-sonnet-5-5", "gpt-6.1-sol", "deepseek-v4-pro"],
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
