import { freeTierDailyHours, nextLocalMidnight, normalizeCountryCode } from "@freebuff/shared";
import type { QuotaDecision, QuotaPolicy, QuotaSnapshot, QuotaWindow } from "@freebuff/shared";

import type { QuotaAccount } from "./account";
import { isWindowActive, openWindow, remainingMinutes, windowBelongsToDay } from "./window";

interface UserState {
  readonly windows: readonly QuotaWindow[];
}

export interface QuotaTrackerOptions {
  readonly now?: () => Date;
}

/**
 * Server-authoritative hour accounting. Starting an hour consumes one hour-credit; messages inside the
 * window are unlimited; windows expire at the earlier of one hour and local midnight; nothing rolls
 * over. Callers can only ask, never assert, so a client that lies about usage cannot buy itself time.
 */
export class QuotaTracker {
  private readonly now: () => Date;
  private readonly states = new Map<string, UserState>();

  constructor(options: QuotaTrackerOptions = {}) {
    this.now = options.now ?? ((): Date => new Date());
  }

  policyFor(account: QuotaAccount): QuotaPolicy {
    return {
      tier: account.tier,
      countryCode: normalizeCountryCode(account.countryCode),
      dailyHours: freeTierDailyHours(account.countryCode, { tier: account.tier }),
      timeZone: account.timeZone,
      resetAtLocalMidnight: true,
    };
  }

  decide(account: QuotaAccount): QuotaDecision {
    const now = this.now();
    const policy = this.policyFor(account);
    const state = this.prunedState(account.userId, now);

    const active = state.windows.find((window) => isWindowActive(window, now));
    if (active !== undefined) {
      return { allowed: true, window: active, remainingMinutes: remainingMinutes(active, now) };
    }

    if (state.windows.length >= policy.dailyHours) {
      const resetsAt = nextLocalMidnight(now, policy.timeZone).toISOString();
      return {
        allowed: false,
        reason: "daily_hours_exhausted",
        resetsAt,
        message: `Your ${String(policy.dailyHours)} free hour(s) for today are used up. Quota resets at local midnight (${policy.timeZone}).`,
      };
    }

    const window = openWindow({ startsAt: now, timeZone: policy.timeZone });
    this.states.set(account.userId, { windows: [...state.windows, window] });
    return { allowed: true, window, remainingMinutes: remainingMinutes(window, now) };
  }

  snapshot(account: QuotaAccount): QuotaSnapshot {
    const now = this.now();
    const policy = this.policyFor(account);
    const state = this.prunedState(account.userId, now);
    const active = state.windows.find((window) => isWindowActive(window, now));

    return {
      policy,
      ...(active === undefined ? {} : { activeWindow: active }),
      remainingMinutes: active === undefined ? 0 : remainingMinutes(active, now),
      windowsStartedToday: state.windows.length,
      phoneVerified: account.phoneVerified,
      serverTime: now.toISOString(),
    };
  }

  /** Drops yesterday's windows: stale credits never carry into the next day. */
  private prunedState(userId: string, now: Date): UserState {
    const existing = this.states.get(userId);
    if (existing === undefined) return { windows: [] };
    const windows = existing.windows.filter((window) => windowBelongsToDay(window, now));
    return windows.length === existing.windows.length ? existing : { windows };
  }
}
