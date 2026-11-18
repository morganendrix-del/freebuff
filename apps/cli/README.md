# @freebuff/cli

Status: **implemented** (Phase 2). Gate: auth → project picker → multi-file edit → terminal command →
chat persistence.

The terminal surface: an OpenTUI + React app for interactive work, Commander commands for scripted
work, TanStack Query for server state, and a terminal broker that keeps shell output away from the
agent's stdio.

## Commands

```bash
freebuff                      # interactive TUI (default)
freebuff login <email>        # store a platform token
freebuff whoami               # account + tier
freebuff projects             # registered projects
freebuff history              # recent sessions
freebuff ask "fix the bug"    # one headless agent turn through the real runtime
freebuff dev [--port 8788]    # run the local platform API and point config at it
freebuff config               # show stored config (token is never printed)
```

Run from the repository it should work on: `bun apps/cli/src/main.tsx ask "…"` (or `bun run start` in
this package).

## Layout

| Path                     | Responsibility                                                                    |
| ------------------------ | --------------------------------------------------------------------------------- |
| `src/main.tsx`           | executable entry: config, provider from env, Commander, lazy TUI import           |
| `src/commands.ts`        | command surface (login, whoami, projects, history, ask, dev, config)              |
| `src/app.tsx`            | OpenTUI React tree: sign-in, project picker, chat, quota bar, sponsored slot      |
| `src/flows/*`            | the gate flows the TUI and commands share: sign-in, project resolution, chat turn |
| `src/state.ts`           | observable store + pure agent-event reducer used by the UI                        |
| `src/queries.ts`         | TanStack Query options for projects, sessions, quota and ads                      |
| `src/terminal/broker.ts` | shell sessions with piped stdio, scrubbed env, timeout/abort kills                |
| `src/platform/*`         | local platform API (auth, projects, sessions, quota, ads, terminal) for Phase 2   |
| `src/ui/*.tsx`           | quota bar and sponsored slot components                                           |

## Behaviour worth knowing

- **Sign-in is real state**: the token is written atomically to `$FREEBUFF_HOME/config.json`
  (default `~/.freebuff`), mode `0600`, and every later call carries it through `@freebuff/sdk`.
- **The agent runs in-process** with `@freebuff/agent-runtime`; only quota, sessions, ads and the shell
  channel go over HTTP. Shell calls are routed through the platform's terminal channel, so the loop
  never spawns a process itself (see `DECISIONS.md` D11, D17).
- **Quota and ads are server decisions**: the status bar mirrors `QuotaSnapshot`; a run starts only
  after `/v1/quota/authorize` says yes. Paid tiers receive no ad selection.
- **Persistence is server-side**: the turn is appended to the session before the CLI reports success,
  and history survives a platform restart.

## Tests

`tests/integration/cli/gate.test.ts` (full path + isolation + restart), `tests/integration/cli/broker.test.ts`
(stdio isolation, env scrubbing, timeout/abort kills, unknown sessions), `tests/unit/cli-state.test.ts`
(store + event reducer). The TUI itself is typechecked and boots (initial frame verified under Bun), but
no interactive pty session is driven in tests.
