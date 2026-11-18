import { describe, expect, test } from "vitest";

import type { QuotaSnapshot } from "@freebuff/shared";

import { formatMinutes, QuotaMirror } from "./client";

function snapshot(overrides: Partial<QuotaSnapshot> = {}): QuotaSnapshot {
  return {
    policy: {
      tier: "free",
      countryCode: "DE",
      dailyHours: 5,
      timeZone: "Europe/Berlin",
      resetAtLocalMidnight: true,
    },
    activeWindow: {
      dayKey: "2026-11-18",
      timeZone: "Europe/Berlin",
      startsAt: "2026-11-18T09:00:00.000Z",
      expiresAt: "2026-11-18T10:00:00.000Z",
    },
    remainingMinutes: 42,
    windowsStartedToday: 1,
    phoneVerified: true,
    serverTime: "2026-11-18T09:18:00.000Z",
    ...overrides,
  };
}

function withoutWindow(base: QuotaSnapshot): QuotaSnapshot {
  return {
    policy: base.policy,
    remainingMinutes: 0,
    windowsStartedToday: base.windowsStartedToday,
    phoneVerified: base.phoneVerified,
    serverTime: base.serverTime,
  };
}

describe("QuotaMirror", () => {
  test("renders remaining time inside the active hour", () => {
    const mirror = new QuotaMirror(snapshot(), {
      now: () => new Date("2026-11-18T09:18:00.000Z"),
    });

    const view = mirror.view();
    expect(view.text).toBe("42m left this hour · 5 h/day");
    expect(view.fill).toBeCloseTo(0.7);
    expect(view.exhausted).toBe(false);
  });

  test("hides the bar when no window is active and reports the daily usage", () => {
    const mirror = new QuotaMirror(withoutWindow(snapshot()), {
      now: () => new Date("2026-11-18T11:00:00.000Z"),
    });

    expect(mirror.view()).toMatchObject({ fill: 0, exhausted: false });
    expect(mirror.view().text).toBe("1 of 5 h used today · resets at midnight");
  });

  test("marks the day exhausted once every hour-credit is spent", () => {
    const mirror = new QuotaMirror(withoutWindow(snapshot({ windowsStartedToday: 5 })), {
      now: () => new Date("2026-11-18T20:00:00.000Z"),
    });

    expect(mirror.view().exhausted).toBe(true);
  });

  test("a newer snapshot replaces local state entirely", () => {
    const mirror = new QuotaMirror(snapshot(), {
      now: () => new Date("2026-11-18T09:18:00.000Z"),
    });

    mirror.update(
      snapshot({
        windowsStartedToday: 4,
        remainingMinutes: 60,
        activeWindow: {
          dayKey: "2026-11-18",
          timeZone: "Europe/Berlin",
          startsAt: "2026-11-18T09:18:00.000Z",
          expiresAt: "2026-11-18T10:18:00.000Z",
        },
      }),
    );
    expect(mirror.view().text).toBe("1h 00m left this hour · 5 h/day");
    expect(mirror.current().windowsStartedToday).toBe(4);
  });

  test("formats minutes for humans", () => {
    expect(formatMinutes(0)).toBe("0m");
    expect(formatMinutes(42)).toBe("42m");
    expect(formatMinutes(60)).toBe("1h 00m");
    expect(formatMinutes(615)).toBe("10h 15m");
  });
});
