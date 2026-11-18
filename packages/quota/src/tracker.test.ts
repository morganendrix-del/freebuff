import { createId } from "@freebuff/shared";
import { describe, expect, test } from "vitest";

import type { QuotaAccount } from "./account";
import { QuotaMirror } from "./client";
import { QuotaTracker } from "./tracker";

const BERLIN = "Europe/Berlin";

function account(overrides: Partial<QuotaAccount> = {}): QuotaAccount {
  return {
    userId: createId("user"),
    tier: "free",
    countryCode: "DE",
    timeZone: BERLIN,
    phoneVerified: true,
    ...overrides,
  };
}

function clock(start: string): { now: () => Date; advance: (ms: number) => void } {
  let instant = new Date(start).getTime();
  return {
    now: () => new Date(instant),
    advance: (ms) => {
      instant += ms;
    },
  };
}

describe("QuotaTracker", () => {
  test("the first decision consumes one hour-credit and messages inside it are unlimited", () => {
    const time = clock("2026-11-18T09:00:00.000Z");
    const tracker = new QuotaTracker({ now: time.now });
    const user = account();

    const first = tracker.decide(user);
    expect(first.allowed).toBe(true);
    if (!first.allowed) throw new Error("expected an allowance");
    expect(first.remainingMinutes).toBe(60);

    time.advance(20 * 60_000);
    const second = tracker.decide(user);
    expect(second.allowed).toBe(true);
    if (!second.allowed) throw new Error("expected an allowance");
    expect(second.window.startsAt).toBe(first.window.startsAt);

    expect(tracker.snapshot(user).windowsStartedToday).toBe(1);
  });

  test("a new credit is consumed only after the previous window expires", () => {
    const time = clock("2026-11-18T09:00:00.000Z");
    const tracker = new QuotaTracker({ now: time.now });
    const user = account();

    tracker.decide(user);
    time.advance(60 * 60_000 + 1);
    const next = tracker.decide(user);

    expect(next.allowed).toBe(true);
    expect(tracker.snapshot(user).windowsStartedToday).toBe(2);
  });

  test("denies once the daily allowance is spent and points at local midnight", () => {
    const time = clock("2026-11-18T06:00:00.000Z");
    const tracker = new QuotaTracker({ now: time.now });
    const user = account();

    for (let hourly = 0; hourly < 8; hourly += 1) {
      const decision = tracker.decide(user);
      expect(decision.allowed).toBe(true);
      time.advance(60 * 60_000 + 1);
    }

    const denied = tracker.decide(user);
    expect(denied.allowed).toBe(false);
    if (denied.allowed) throw new Error("expected a denial");
    expect(denied.reason).toBe("daily_hours_exhausted");
    expect(denied.resetsAt).toBe("2026-11-18T23:00:00.000Z");
    expect(denied.message).toContain("local midnight");
  });

  test("yesterday's windows never roll over", () => {
    const time = clock("2026-11-18T20:00:00.000Z"); // 21:00 Berlin
    const tracker = new QuotaTracker({ now: time.now });
    const user = account();

    tracker.decide(user);
    expect(tracker.snapshot(user).windowsStartedToday).toBe(1);

    time.advance(5 * 60 * 60_000); // 02:00 Berlin the next day
    const snapshot = tracker.snapshot(user);
    expect(snapshot.windowsStartedToday).toBe(0);
    expect(snapshot.activeWindow).toBeUndefined();

    const decision = tracker.decide(user);
    expect(decision.allowed).toBe(true);
    if (!decision.allowed) throw new Error("expected an allowance");
    expect(decision.window.dayKey).toBe("2026-11-19");
  });

  test("a client mirror cannot extend the allowance", () => {
    const time = clock("2026-11-18T09:00:00.000Z");
    const tracker = new QuotaTracker({ now: time.now });
    const user = account();

    tracker.decide(user);
    const snapshot = tracker.snapshot(user);
    const mirror = new QuotaMirror({ ...snapshot, remainingMinutes: 600 }, { now: time.now });
    expect(mirror.view().fill).toBe(1);

    // The mirror is a view: mutating it changes nothing the server will decide.
    const server = tracker.snapshot(user);
    expect(server.remainingMinutes).toBe(60);
    expect(server.windowsStartedToday).toBe(1);
  });

  test("paid tiers scale the allowance through tier entitlements", () => {
    const time = clock("2026-11-18T09:00:00.000Z");
    const tracker = new QuotaTracker({ now: time.now });

    expect(tracker.policyFor(account({ tier: "free" })).dailyHours).toBe(8);
    expect(tracker.policyFor(account({ tier: "pro" })).dailyHours).toBe(32);
    expect(tracker.policyFor(account({ countryCode: "US" })).dailyHours).toBe(30);
    expect(tracker.policyFor(account({ timeZone: "America/New_York" })).resetAtLocalMidnight).toBe(
      true,
    );
  });
});
