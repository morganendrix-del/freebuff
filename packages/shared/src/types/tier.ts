/** Free tier is ad-supported and quota-limited; pro removes ads and raises limits. */
export type AgentTier = "free" | "pro";

export interface TierEntitlements {
  readonly tier: AgentTier;
  readonly label: string;
  /** Free tier renders sponsored slots; paid tiers do not. */
  readonly adsEnabled: boolean;
  /** Whether premium models (tier `pro` in the catalogue) are selectable. */
  readonly premiumModels: boolean;
  readonly maxSubagents: number;
  /** Multiplier applied to the country free-tier hours when computing the paid allowance. */
  readonly hoursMultiplier: number;
}

const TIER_RANK: Readonly<Record<AgentTier, number>> = { free: 0, pro: 1 };

/** True when `tier` meets or exceeds `minimum`. */
export function tierAtLeast(tier: AgentTier, minimum: AgentTier): boolean {
  return TIER_RANK[tier] >= TIER_RANK[minimum];
}
