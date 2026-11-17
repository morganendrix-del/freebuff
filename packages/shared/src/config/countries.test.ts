import { describe, expect, test } from "vitest";

import { PlatformError } from "../utils/errors";
import {
  DEFAULT_FREE_TIER_DAILY_HOURS,
  US_FREE_TIER_DAILY_HOURS,
  freeTierDailyHours,
  normalizeCountryCode,
  parseDailyHoursOverrides,
} from "./countries";

describe("normalizeCountryCode", () => {
  test("uppercases valid alpha-2 codes", () => {
    expect(normalizeCountryCode("us")).toBe("US");
    expect(normalizeCountryCode(" de ")).toBe("DE");
  });

  test("rejects unusable input", () => {
    expect(normalizeCountryCode("USA")).toBe("");
    expect(normalizeCountryCode("1X")).toBe("");
    expect(normalizeCountryCode(undefined)).toBe("");
    expect(normalizeCountryCode("")).toBe("");
  });
});

describe("freeTierDailyHours", () => {
  test("US gets the configured 30 hours, unlisted countries the 5 hour default", () => {
    expect(freeTierDailyHours("US")).toBe(US_FREE_TIER_DAILY_HOURS);
    expect(freeTierDailyHours("ZZ")).toBe(DEFAULT_FREE_TIER_DAILY_HOURS);
    expect(freeTierDailyHours(undefined)).toBe(DEFAULT_FREE_TIER_DAILY_HOURS);
  });

  test("overrides beat the built-in table and are case-insensitive", () => {
    expect(freeTierDailyHours("us", { overrides: { US: 12 } })).toBe(12);
    expect(freeTierDailyHours("zz", { overrides: { ZZ: 8 } })).toBe(8);
  });

  test("paid tier scales the allowance by entitlements", () => {
    expect(freeTierDailyHours("US", { tier: "pro" })).toBe(US_FREE_TIER_DAILY_HOURS * 4);
  });
});

describe("parseDailyHoursOverrides", () => {
  test("parses a JSON object of country hours", () => {
    expect(parseDailyHoursOverrides('{"us":30,"DE":8}')).toEqual({ US: 30, DE: 8 });
    expect(parseDailyHoursOverrides("")).toEqual({});
    expect(parseDailyHoursOverrides(undefined)).toEqual({});
  });

  test("rejects malformed configuration", () => {
    expect(() => parseDailyHoursOverrides("not json")).toThrow(PlatformError);
    expect(() => parseDailyHoursOverrides("[30]")).toThrow(PlatformError);
    expect(() => parseDailyHoursOverrides('{"USA":5}')).toThrow(PlatformError);
    expect(() => parseDailyHoursOverrides('{"US":"30"}')).toThrow(PlatformError);
    expect(() => parseDailyHoursOverrides('{"US":0}')).toThrow(PlatformError);
    expect(() => parseDailyHoursOverrides('{"US":1000}')).toThrow(PlatformError);
  });
});
