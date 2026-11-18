import type { IanaTimeZone, IsoTimestamp } from "../types/time";
import { PlatformError } from "./errors";

/**
 * Time-zone aware calendar helpers used by quota windows and "resets at local midnight" rules.
 * All math goes through `Intl`, never the server's timezone.
 */

interface ZonedParts {
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly hour: number;
  readonly minute: number;
  readonly second: number;
}

const FORMATTER_CACHE = new Map<string, Intl.DateTimeFormat>();
const DAY_MS = 86_400_000;

function formatterFor(timeZone: IanaTimeZone): Intl.DateTimeFormat {
  const cached = FORMATTER_CACHE.get(timeZone);
  if (cached) return cached;

  let formatter: Intl.DateTimeFormat;
  try {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    });
  } catch (error) {
    throw new PlatformError("invalid_time_zone", `Unknown IANA time zone "${timeZone}".`, {
      cause: error,
    });
  }

  FORMATTER_CACHE.set(timeZone, formatter);
  return formatter;
}

function zonedParts(instant: Date, timeZone: IanaTimeZone): ZonedParts {
  const parts = formatterFor(timeZone).formatToParts(instant);
  const values = new Map<string, number>();
  for (const part of parts) {
    if (part.type === "literal") continue;
    values.set(part.type, Number.parseInt(part.value, 10));
  }

  return {
    year: values.get("year") ?? 0,
    month: values.get("month") ?? 1,
    day: values.get("day") ?? 1,
    hour: values.get("hour") ?? 0,
    minute: values.get("minute") ?? 0,
    second: values.get("second") ?? 0,
  };
}

/** Offset of `timeZone` from UTC at `instant`, in milliseconds (east of UTC is positive). */
function zoneOffsetMs(instant: Date, timeZone: IanaTimeZone): number {
  const parts = zonedParts(instant, timeZone);
  const asUtc = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
  );
  const truncatedMs = Math.floor(instant.getTime() / 1000) * 1000;
  return asUtc - truncatedMs;
}

/**
 * Converts wall-clock time (given as a UTC epoch of the *local* calendar values) into the real
 * instant. Iterates to settle on the right offset, so DST transitions resolve correctly.
 */
function wallClockToInstant(wallClockMs: number, timeZone: IanaTimeZone): number {
  let guess = wallClockMs;
  for (let iteration = 0; iteration < 4; iteration += 1) {
    const offset = zoneOffsetMs(new Date(guess), timeZone);
    const next = wallClockMs - offset;
    if (next === guess) return next;
    guess = next;
  }
  return guess;
}

function formatDayKey(year: number, month: number, day: number): string {
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/** Local calendar day key (`YYYY-MM-DD`) for an instant in a time zone. */
export function dayKey(instant: Date, timeZone: IanaTimeZone): string {
  const parts = zonedParts(instant, timeZone);
  return formatDayKey(parts.year, parts.month, parts.day);
}

const ADJUST_STEP_MS = 15 * 60 * 1000;
const MAX_ADJUST_STEPS = 16;

/**
 * First instant whose local calendar date is the requested one.
 *
 * Midday is unambiguous; local midnight is not. Some zones (America/Santiago, for example) move
 * the clock at midnight, so "00:00 local" on that date never happens. Resolving the wall clock can
 * land just before the target date, so walk forward in 15 minute steps until the local date is
 * reached — bounded, because a midnight skip is at most an hour long.
 */
function firstInstantOfLocalDate(
  year: number,
  month: number,
  day: number,
  timeZone: IanaTimeZone,
): Date {
  const wallClock = Date.UTC(year, month - 1, day, 0, 0, 0, 0);
  const targetDayKey = formatDayKey(year, month, day);
  let candidate = new Date(wallClockToInstant(wallClock, timeZone));

  for (
    let step = 0;
    step < MAX_ADJUST_STEPS && dayKey(candidate, timeZone) < targetDayKey;
    step += 1
  ) {
    candidate = new Date(candidate.getTime() + ADJUST_STEP_MS);
  }

  return candidate;
}

/** Instant at which the local day containing `instant` started. */
export function startOfLocalDay(instant: Date, timeZone: IanaTimeZone): Date {
  const parts = zonedParts(instant, timeZone);
  return firstInstantOfLocalDate(parts.year, parts.month, parts.day, timeZone);
}

/** Instant of the next local midnight after `instant` (quota reset boundary). */
export function nextLocalMidnight(instant: Date, timeZone: IanaTimeZone): Date {
  const parts = zonedParts(instant, timeZone);
  const tomorrow = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + 1));
  return firstInstantOfLocalDate(
    tomorrow.getUTCFullYear(),
    tomorrow.getUTCMonth() + 1,
    tomorrow.getUTCDate(),
    timeZone,
  );
}

export interface LocalDayWindow {
  readonly dayKey: string;
  readonly timeZone: IanaTimeZone;
  readonly startsAt: IsoTimestamp;
  readonly expiresAt: IsoTimestamp;
}

/** The local calendar day containing `instant`, expressed as UTC timestamps. */
export function localDayWindow(instant: Date, timeZone: IanaTimeZone): LocalDayWindow {
  return {
    dayKey: dayKey(instant, timeZone),
    timeZone,
    startsAt: startOfLocalDay(instant, timeZone).toISOString(),
    expiresAt: nextLocalMidnight(instant, timeZone).toISOString(),
  };
}

export function isWithinWindow(
  instant: Date,
  startsAt: IsoTimestamp,
  expiresAt: IsoTimestamp,
): boolean {
  const time = instant.getTime();
  return time >= Date.parse(startsAt) && time < Date.parse(expiresAt);
}

/** Whole days between two instants, rounded down. */
export function daysBetween(from: Date, to: Date): number {
  return Math.floor((to.getTime() - from.getTime()) / DAY_MS);
}
