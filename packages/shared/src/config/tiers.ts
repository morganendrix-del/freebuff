import type { AgentTier } from "../types/tier";

/** Tier labels and entitlements. Paid tier removes ads, raises limits, unlocks premium models. */
export const TIER_ENTITLEMENTS: Readonly<Record<AgentTier, TierEntitlementsView>> = {
  free: {
    tier: "free",
    label: "Free",
    adsEnabled: true,
    premiumModels: false,
    maxSubagents: 2,
    hoursMultiplier: 1,
  },
  pro: {
    tier: "pro",
    label: "Pro",
    adsEnabled: false,
    premiumModels: true,
    maxSubagents: 6,
    hoursMultiplier: 4,
  },
};

export interface TierEntitlementsView {
  readonly tier: AgentTier;
  readonly label: string;
  readonly adsEnabled: boolean;
  readonly premiumModels: boolean;
  readonly maxSubagents: number;
  readonly hoursMultiplier: number;
}

export function entitlementsFor(tier: AgentTier): TierEntitlementsView {
  return TIER_ENTITLEMENTS[tier];
}
