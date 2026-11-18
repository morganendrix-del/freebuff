import type { AgentTier } from "./tier";

export type ProviderId = "anthropic" | "deepseek" | "openai";

export type ModelCapability = "prompt_caching" | "reasoning" | "streaming" | "tools" | "vision";

export interface ModelPricing {
  /** Standard (or peak, for providers that bill by time of day) input rate. */
  readonly inputPerMTokUsd: number;
  readonly outputPerMTokUsd: number;
  readonly cachedInputPerMTokUsd?: number;
  readonly offPeakInputPerMTokUsd?: number;
  readonly offPeakOutputPerMTokUsd?: number;
}

export interface ModelSpec {
  /** Provider-native model identifier, e.g. `deepseek-chat`. */
  readonly id: string;
  readonly provider: ProviderId;
  readonly displayName: string;
  readonly contextWindow: number;
  readonly maxOutputTokens: number;
  readonly capabilities: readonly ModelCapability[];
  readonly pricing: ModelPricing;
  /** Lowest tier allowed to select this model. */
  readonly minimumTier: AgentTier;
  readonly supportsParallelToolCalls: boolean;
}

export type ModelSelectionErrorCode = "tier_not_permitted" | "unknown_model";

export interface ModelSelectionError {
  readonly code: ModelSelectionErrorCode;
  readonly message: string;
  readonly modelId: string;
  readonly tier: AgentTier;
  readonly requiredTier?: AgentTier;
}
