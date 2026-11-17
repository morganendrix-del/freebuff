import { describe, expect, test } from "vitest";

import { PlatformError } from "./errors";
import { dayKey, isWithinWindow, localDayWindow, nextLocalMidnight, startOfLocalDay } from "./time";

const NEW_YORK = "America/New_York";
const KOLKATA = "Asia/Kolkata";

describe("dayKey", () => {
  test("uses the requested calendar day, not the server's", () => {
    const instant = new Date("2026-01-01T00:30:00.000Z");
    expect(dayKey(instant, "UTC")).toBe("2026-01-01");
    expect(dayKey(instant, NEW_YORK)).toBe("2025-12-31");
    expect(dayKey(instant, KOLKATA)).toBe("2026-01-01");
  });

  test("rejects unknown time zones", () => {
    expect(() => dayKey(new Date(), "Mars/Olympus")).toThrow(PlatformError);
  });
});

describe("localDayWindow", () => {
  test("summer day is 24 hours in New York", () => {
    const window = localDayWindow(new Date("2026-07-01T12:00:00.000Z"), NEW_YORK);
    expect(window.dayKey).toBe("2026-07-01");
    expect(window.startsAt).toBe("2026-07-01T04:00:00.000Z");
    expect(window.expiresAt).toBe("2026-07-02T04:00:00.000Z");
  });

  test("spring-forward day is 23 hours", () => {
    const window = localDayWindow(new Date("2026-03-08T12:00:00.000Z"), NEW_YORK);
    expect(window.startsAt).toBe("2026-03-08T05:00:00.000Z");
    expect(window.expiresAt).toBe("2026-03-09T04:00:00.000Z");
  });

  test("fall-back day is 25 hours", () => {
    const window = localDayWindow(new Date("2026-11-01T12:00:00.000Z"), NEW_YORK);
    expect(window.startsAt).toBe("2026-11-01T04:00:00.000Z");
    expect(window.expiresAt).toBe("2026-11-02T05:00:00.000Z");
  });

  test("half-hour offsets reset at local midnight", () => {
    const window = localDayWindow(new Date("2026-07-01T12:00:00.000Z"), KOLKATA);
    expect(window.startsAt).toBe("2026-06-30T18:30:00.000Z");
    expect(window.expiresAt).toBe("2026-07-01T18:30:00.000Z");
  });

  test("window boundaries are half-open", () => {
    const window = localDayWindow(new Date("2026-07-01T12:00:00.000Z"), NEW_YORK);
    expect(isWithinWindow(new Date(window.startsAt), window.startsAt, window.expiresAt)).toBe(true);
    expect(isWithinWindow(new Date(window.expiresAt), window.startsAt, window.expiresAt)).toBe(
      false,
    );
    expect(
      isWithinWindow(
        new Date(new Date(window.startsAt).getTime() - 1),
        window.startsAt,
        window.expiresAt,
      ),
    ).toBe(false);
  });
});

describe("nextLocalMidnight", () => {
  test("lands exactly on local midnight across a DST change", () => {
    const next = nextLocalMidnight(new Date("2026-03-08T12:00:00.000Z"), NEW_YORK);
    expect(next.toISOString()).toBe("2026-03-09T04:00:00.000Z");
    expect(dayKey(next, NEW_YORK)).toBe("2026-03-09");
  });

  test("startOfLocalDay and nextLocalMidnight bracket the day", () => {
    const instant = new Date("2026-11-17T23:45:00.000Z");
    const start = startOfLocalDay(instant, KOLKATA);
    const end = nextLocalMidnight(instant, KOLKATA);
    expect(end.getTime() - start.getTime()).toBe(24 * 60 * 60 * 1000);
  });
});
