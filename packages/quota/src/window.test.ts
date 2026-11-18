import { describe, expect, test } from "vitest";

import { isWindowActive, openWindow, remainingMinutes, WINDOW_DURATION_MS } from "./window";

const BERLIN = "Europe/Berlin";

describe("quota windows", () => {
  test("a midday window lasts one hour", () => {
    const startsAt = new Date("2026-11-18T09:00:00.000Z");
    const window = openWindow({ startsAt, timeZone: BERLIN });

    expect(Date.parse(window.expiresAt) - startsAt.getTime()).toBe(WINDOW_DURATION_MS);
    expect(window.dayKey).toBe("2026-11-18");
    expect(window.timeZone).toBe(BERLIN);
  });

  test("a late-evening window is cut at local midnight instead of overflowing into tomorrow", () => {
    // 23:30 in Berlin (CET, UTC+1).
    const startsAt = new Date("2026-11-18T22:30:00.000Z");
    const window = openWindow({ startsAt, timeZone: BERLIN });

    expect(window.expiresAt).toBe("2026-11-18T23:00:00.000Z");
    expect(Date.parse(window.expiresAt) - startsAt.getTime()).toBe(30 * 60_000);
  });

  test("the midnight cut follows DST transitions", () => {
    // Berlin springs forward at 02:00 on 2026-03-29; local midnight is still 23:00Z the day before.
    const startsAt = new Date("2026-03-28T22:45:00.000Z");
    const window = openWindow({ startsAt, timeZone: BERLIN });

    expect(window.expiresAt).toBe("2026-03-28T23:00:00.000Z");
    expect(Date.parse(window.expiresAt) - startsAt.getTime()).toBe(15 * 60_000);
  });

  test("half-hour offset zones cut at their own midnight", () => {
    const startsAt = new Date("2026-11-18T18:10:00.000Z"); // 23:40 in Kolkata (UTC+5:30)
    const window = openWindow({ startsAt, timeZone: "Asia/Kolkata" });

    expect(window.expiresAt).toBe("2026-11-18T18:30:00.000Z");
  });

  test("activity and remaining minutes are half-open at the expiry instant", () => {
    const startsAt = new Date("2026-11-18T09:00:00.000Z");
    const window = openWindow({ startsAt, timeZone: BERLIN });

    expect(isWindowActive(window, new Date("2026-11-18T09:00:00.000Z"))).toBe(true);
    expect(isWindowActive(window, new Date("2026-11-18T09:59:59.000Z"))).toBe(true);
    expect(isWindowActive(window, new Date("2026-11-18T10:00:00.000Z"))).toBe(false);
    expect(remainingMinutes(window, new Date("2026-11-18T09:00:00.000Z"))).toBe(60);
    expect(remainingMinutes(window, new Date("2026-11-18T09:30:30.000Z"))).toBe(30);
    expect(remainingMinutes(window, new Date("2026-11-18T10:30:00.000Z"))).toBe(0);
  });
});
