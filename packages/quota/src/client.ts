import type { QuotaSnapshot } from "@freebuff/shared";

import { remainingMinutes } from "./window";

export interface QuotaMirrorOptions {
  readonly now?: () => Date;
}

export interface QuotaBarView {
  /** What the status bar shows, e.g. `0:42 left of 5 h today`. */
  readonly text: string;
  /** 0–1 fill for the bar; only ever derived from the last server snapshot. */
  readonly fill: number;
  readonly exhausted: boolean;
}

/**
 * Client-side mirror of the server snapshot. UX only: it renders what the server last said and never
 * decides access. `update` always replaces the whole snapshot, so local arithmetic cannot extend time.
 */
export class QuotaMirror {
  private snapshot: QuotaSnapshot;
  private readonly now: () => Date;

  constructor(snapshot: QuotaSnapshot, options: QuotaMirrorOptions = {}) {
    this.snapshot = snapshot;
    this.now = options.now ?? ((): Date => new Date());
  }

  update(snapshot: QuotaSnapshot): void {
    this.snapshot = snapshot;
  }

  current(): QuotaSnapshot {
    return this.snapshot;
  }

  remainingMinutes(): number {
    const active = this.snapshot.activeWindow;
    if (active === undefined) return 0;
    return remainingMinutes(active, this.now());
  }

  exhausted(): boolean {
    if (this.snapshot.activeWindow !== undefined) return this.remainingMinutes() === 0;
    return this.snapshot.windowsStartedToday >= this.snapshot.policy.dailyHours;
  }

  view(): QuotaBarView {
    const active = this.snapshot.activeWindow;
    const left = this.remainingMinutes();
    const text =
      active === undefined
        ? `${String(this.snapshot.windowsStartedToday)} of ${String(
            this.snapshot.policy.dailyHours,
          )} h used today · resets at midnight`
        : `${formatMinutes(left)} left this hour · ${String(
            this.snapshot.policy.dailyHours,
          )} h/day`;

    return {
      text,
      fill: active === undefined ? 0 : Math.min(1, Math.max(0, left / 60)),
      exhausted: this.exhausted(),
    };
  }
}

export function formatMinutes(minutes: number): string {
  const clamped = Math.max(0, Math.round(minutes));
  const hours = Math.floor(clamped / 60);
  const rest = clamped % 60;
  return hours > 0 ? `${String(hours)}h ${String(rest).padStart(2, "0")}m` : `${String(rest)}m`;
}
