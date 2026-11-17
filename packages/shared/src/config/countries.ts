import { PlatformError } from "../utils/errors";
import type { AgentTier } from "../types/tier";
import { entitlementsFor } from "./tiers";

/**
 * Free-tier hour allowance by country. Configuration, never logic: every value can be overridden
 * (`FREE_TIER_DAILY_HOURS_JSON`) and the default covers unlisted countries.
 *
 * An "hour" is one hour-credit for an active session; unlimited messages are allowed inside it, and
 * the allowance resets at local midnight with no rollover. Because sessions can run concurrently the
 * daily allowance is not capped at 24.
 */
export const DEFAULT_FREE_TIER_DAILY_HOURS = 5;

export const US_FREE_TIER_DAILY_HOURS = 30;

export const FREE_TIER_DAILY_HOURS_BY_COUNTRY: Readonly<Record<string, number>> = {
  US: US_FREE_TIER_DAILY_HOURS,
  CA: 30,
  GB: 12,
  AU: 12,
  DE: 8,
  FR: 8,
  NL: 8,
  JP: 10,
  IN: 6,
  BR: 6,
  MX: 6,
};

export const MIN_DAILY_HOURS = 0.5;
export const MAX_DAILY_HOURS = 240;

const COUNTRY_CODE_PATTERN = /^[A-Z]{2}$/;

/** Uppercases and validates an ISO-3166 alpha-2 code; returns "" when unusable. */
export function normalizeCountryCode(input: string | null | undefined): string {
  if (typeof input !== "string") return "";
  const code = input.trim().toUpperCase();
  return COUNTRY_CODE_PATTERN.test(code) ? code : "";
}

export interface FreeTierDailyHoursOptions {
  readonly overrides?: Readonly<Record<string, number>>;
  readonly tier?: AgentTier;
}

/** Daily hour allowance for a country, scaled by tier entitlements and clamped to safe bounds. */
export function freeTierDailyHours(
  countryCode: string | null | undefined,
  options: FreeTierDailyHoursOptions = {},
): number {
  const code = normalizeCountryCode(countryCode);
  const overrides = options.overrides ?? {};
  const base =
    overrides[code] ?? FREE_TIER_DAILY_HOURS_BY_COUNTRY[code] ?? DEFAULT_FREE_TIER_DAILY_HOURS;
  const multiplier = entitlementsFor(options.tier ?? "free").hoursMultiplier;
  const scaled = base * multiplier;
  return Math.min(MAX_DAILY_HOURS, Math.max(MIN_DAILY_HOURS, Math.round(scaled * 100) / 100));
}

/** Parses `FREE_TIER_DAILY_HOURS_JSON`, e.g. `{"US":30,"DE":8}`. */
export function parseDailyHoursOverrides(
  input: string | null | undefined,
): Readonly<Record<string, number>> {
  if (typeof input !== "string" || input.trim() === "") return {};

  let parsed: unknown;
  try {
    parsed = JSON.parse(input);
  } catch {
    throw new PlatformError(
      "invalid_config",
      "FREE_TIER_DAILY_HOURS_JSON must be a JSON object of country code to hours.",
    );
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new PlatformError("invalid_config", "FREE_TIER_DAILY_HOURS_JSON must be a JSON object.");
  }

  const overrides: Record<string, number> = {};
  for (const [key, value] of Object.entries(parsed)) {
    const code = normalizeCountryCode(key);
    if (code === "") {
      throw new PlatformError(
        "invalid_config",
        `Invalid country code in quota overrides: "${key}".`,
      );
    }
    if (typeof value !== "number" || !Number.isFinite(value)) {
      throw new PlatformError("invalid_config", `Daily hours for ${code} must be a number.`);
    }
    if (value < MIN_DAILY_HOURS || value > MAX_DAILY_HOURS) {
      throw new PlatformError(
        "invalid_config",
        `Daily hours for ${code} must be between ${String(MIN_DAILY_HOURS)} and ${String(MAX_DAILY_HOURS)}.`,
      );
    }
    overrides[code] = value;
  }

  return overrides;
}
