import type { Id } from "./ids";
import type { Surface } from "./session";
import type { AgentTier } from "./tier";
import type { IanaTimeZone, IsoTimestamp } from "./time";

export type QuotaDenialReason =
  | "account_suspended"
  | "daily_hours_exhausted"
  | "no_active_window"
  | "phone_verification_required"
  | "tier_unavailable";

/** Server-authoritative quota rules for one user. */
export interface QuotaPolicy {
  readonly tier: AgentTier;
  readonly countryCode: string;
  readonly dailyHours: number;
  readonly timeZone: IanaTimeZone;
  /** Quota always resets at local midnight; there is no rollover. */
  readonly resetAtLocalMidnight: true;
}

/**
 * One active hour of agent use. Starting a window consumes one hour-credit; unlimited messages are
 * allowed inside it. `expiresAt` is the earlier of the window end and local midnight.
 */
export interface QuotaWindow {
  readonly dayKey: string;
  readonly timeZone: IanaTimeZone;
  readonly startsAt: IsoTimestamp;
  readonly expiresAt: IsoTimestamp;
}

export interface QuotaSnapshot {
  readonly policy: QuotaPolicy;
  readonly activeWindow?: QuotaWindow;
  readonly remainingMinutes: number;
  readonly windowsStartedToday: number;
  readonly phoneVerified: boolean;
  readonly serverTime: IsoTimestamp;
}

export type QuotaDecision =
  | {
      readonly allowed: true;
      readonly window: QuotaWindow;
      readonly remainingMinutes: number;
    }
  | {
      readonly allowed: false;
      readonly reason: QuotaDenialReason;
      readonly resetsAt: IsoTimestamp;
      readonly message: string;
      readonly verificationUrl?: string;
    };

/** Metering event; the server derives windows from these, clients never send them. */
export interface QuotaUsageEvent {
  readonly sessionId: Id<"session">;
  readonly userId: Id<"user">;
  readonly surface: Surface;
  readonly occurredAt: IsoTimestamp;
  readonly windowDayKey: string;
}
