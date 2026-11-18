import { dayKey, nextLocalMidnight } from "@freebuff/shared";
import type { IanaTimeZone, QuotaWindow } from "@freebuff/shared";

/** One window is one hour-credit; messages inside it are unlimited. */
export const WINDOW_DURATION_MS = 60 * 60 * 1000;

export interface OpenWindowInput {
  readonly startsAt: Date;
  readonly timeZone: IanaTimeZone;
}

/**
 * Opens a window that expires at the earlier of one hour and the next local midnight, so a window can
 * never carry usage across a day boundary and nothing rolls over.
 */
export function openWindow({ startsAt, timeZone }: OpenWindowInput): QuotaWindow {
  const midnight = nextLocalMidnight(startsAt, timeZone);
  const nominalEnd = startsAt.getTime() + WINDOW_DURATION_MS;
  const expiresAt = nominalEnd <= midnight.getTime() ? nominalEnd : midnight.getTime();

  return {
    dayKey: dayKey(startsAt, timeZone),
    timeZone,
    startsAt: startsAt.toISOString(),
    expiresAt: new Date(expiresAt).toISOString(),
  };
}

export function isWindowActive(window: QuotaWindow, now: Date): boolean {
  const instant = now.getTime();
  return instant >= Date.parse(window.startsAt) && instant < Date.parse(window.expiresAt);
}

/** Whole minutes left in a window, never negative. */
export function remainingMinutes(window: QuotaWindow, now: Date): number {
  const left = Date.parse(window.expiresAt) - now.getTime();
  return left <= 0 ? 0 : Math.ceil(left / 60_000);
}

export function windowBelongsToDay(window: QuotaWindow, now: Date): boolean {
  return window.dayKey === dayKey(now, window.timeZone);
}
