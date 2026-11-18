# @freebuff/quota

Status: **implemented** (Phase 2) — window maths, tracker and client mirror. Country policy and phone
verification land in Phase 5.

Server-authoritative hour accounting for the free tier: starting an hour consumes one hour-credit,
messages inside that window are unlimited, the window expires at the earlier of one hour and local
midnight, and nothing rolls over.

## Surface

| Module       | Responsibility                                                               |
| ------------ | ---------------------------------------------------------------------------- |
| `window.ts`  | `openWindow`, `isWindowActive`, `remainingMinutes` — DST-aware midnight cut  |
| `tracker.ts` | `QuotaTracker.decide` / `snapshot`: the server decides, callers can only ask |
| `client.ts`  | `QuotaMirror`: renders the last server snapshot for UX; never grants access  |
| `account.ts` | `QuotaAccount`: who the decision is about                                    |

```ts
const tracker = new QuotaTracker(); // inject `now` in tests
const decision = tracker.decide(account); // { allowed: true, window, remainingMinutes }
```

Allowances come from `freeTierDailyHours(countryCode, { tier })` in `@freebuff/shared`, so a country
override or a paid tier changes the number without touching this package. A window cut short by local
midnight is intentional: `Europe/Berlin` at 23:30 yields a 30-minute window and a fresh allowance the
next day, including across DST and half-hour offset zones.

## Why the client cannot cheat

`QuotaTracker.decide(account)` takes no usage claims and reads its own clock. `QuotaMirror.update`
replaces state wholesale, so arithmetic in a client cannot extend a window; it only changes what that
client displays.

## Tests

`src/window.test.ts` (midday, midnight, DST, half-hour zones, boundary instants), `src/tracker.test.ts`
(credit consumption, unlimited messages inside a window, daily denial, no rollover, lying client, tier
scaling), `src/client.test.ts` (bar rendering and snapshot replacement).
