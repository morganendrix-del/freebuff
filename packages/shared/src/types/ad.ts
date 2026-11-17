import type { Id } from "./ids";
import type { Surface } from "./session";
import type { AgentTier } from "./tier";
import type { IsoTimestamp } from "./time";

/** Displayed verbatim next to every sponsored slot. Non-deceptive labelling is a type-level rule. */
export const SPONSORED_LABEL = "Sponsored";

export interface AdCreative {
  readonly id: Id<"ad">;
  readonly sponsor: string;
  readonly headline: string;
  readonly body: string;
  readonly displayUrl: string;
  readonly targetUrl: string;
  readonly categories: readonly string[];
  readonly label: typeof SPONSORED_LABEL;
  /** Tiers that may see this slot. Paid tiers normally have ads disabled entirely. */
  readonly eligibleTiers: readonly AgentTier[];
  readonly weight: number;
  readonly active: boolean;
}

export type AdPosition = "between_turns" | "session_header" | "status_bar";

export interface AdSlot {
  readonly surface: Surface;
  readonly position: AdPosition;
  readonly maxChars: number;
}

/**
 * Contextual targeting input. Only derived signal crosses the platform boundary: tags plus an
 * optional embedding. The raw prompt never leaves the platform (spec §2F).
 */
export interface AdTargetingContext {
  readonly surface: Surface;
  readonly tier: AgentTier;
  readonly locale: string;
  readonly contextTags: readonly string[];
  readonly embedding?: readonly number[];
}

export interface AdSelection {
  readonly creative: AdCreative;
  readonly slot: AdSlot;
  readonly label: typeof SPONSORED_LABEL;
}

export interface AdImpression {
  readonly adId: Id<"ad">;
  readonly sessionId: Id<"session">;
  readonly surface: Surface;
  readonly shownAt: IsoTimestamp;
  readonly clickedAt?: IsoTimestamp;
}
