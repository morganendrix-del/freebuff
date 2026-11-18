# PROGRESS

Updated at the end of every phase and whenever a gate result changes.

## Phase status

| Phase | Scope                                   | Status      | Gate                                                     |
| ----- | --------------------------------------- | ----------- | -------------------------------------------------------- |
| 0     | Foundation: monorepo, CI, types, infra  | gate passed | `bun run check` clean + CI green on skeleton             |
| 1     | Agent runtime + providers + code map    | gate passed | 5/5 scripted fixture tasks produce expected diffs        |
| 2     | CLI (OpenTUI/React) + terminal broker   | gate passed | auth → picker → multi-file edit → command → persistence  |
| 3     | Cloud sandbox + GitHub import + preview | not started | public repo → live preview URL < 120 s, isolation proven |
| 4     | Web app builder + eject to GitHub       | not started | one prompt → deployed app with auth, DB, storage, eject  |
| 5     | Monetization + desktop + hardening      | not started | free tier under quota, ads, paid tier, signed installers |

## Gate results

### Phase 0 — passed 2026-11-17

| Check                                                                                                    | Result                                                                                                                                                       |
| -------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `bun run format:check`                                                                                   | pass                                                                                                                                                         |
| `bun run lint` (ESLint strictTypeChecked, 0 warnings)                                                    | pass                                                                                                                                                         |
| `bun run typecheck` (`tsc --noEmit`, strict + `noUncheckedIndexedAccess` + `exactOptionalPropertyTypes`) | pass                                                                                                                                                         |
| `bun run test` (Vitest)                                                                                  | pass — 11 files, 66 tests at the time (84 after Phase 1 additions to `shared`)                                                                               |
| `bun run build` (`bun build packages/shared`)                                                            | pass — `dist/index.js` 25.21 KB                                                                                                                              |
| `docker compose -f infra/docker-compose.yml config`                                                      | pass                                                                                                                                                         |
| Sandbox image build + `/health` boot                                                                     | CI only — no Docker daemon locally. The `sandbox-image` job builds the image and probes `/health`, and had to be fixed once (entrypoint moved out of tmpfs). |
| GitHub Actions CI                                                                                        | **green** on `phase-0/foundation` after the `sandbox-image` fix (`17f1291`).                                                                                 |

### Phase 1 — passed 2026-11-18 (pushed, CI green)

`bun run check` and `bun run build` clean: 21 test files, 137 tests, 0 lint warnings, no `tsc` errors.
CI run `44211188752` on `1a1b2d3` concluded success.

| Gate requirement (expanded)                                              | Evidence                                                                                                                                                                                                                                                | Result |
| ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| 5/5 scripted fixture tasks produce expected diffs                        | `tests/integration/agent/tasks.test.ts`: bugfix, multifile, newfile, search, subagents — each compares the full working tree against the expected diff                                                                                                  | pass   |
| Provider shims pass recorded-HTTP tests (DeepSeek, OpenAI, Anthropic)    | `packages/llm-providers/test/*`: 22 tests. Each shim covers request mapping, streaming, tool calls, 429 retry, repeated 5xx/529 exhaustion, 401 no-retry, timeout, truncated/malformed stream and in-flight abort                                       | pass   |
| Tool-call parsing deterministic on adversarial inputs                    | `packages/agent-runtime/test/parsing.test.ts`: 12 tests — malformed JSON, truncated JSON, non-object arguments, unknown tools, schema violations, unexpected properties, out-of-order/duplicate fragments, interleaved text+thinking, re-parse identity | pass   |
| Mid-stream cancellation leaves no orphaned subprocess or connection      | `tests/integration/cancellation.test.ts`: 2 tests — aborting during `run_command` kills the OS process (`process.kill(pid, 0)` fails afterwards) and the run reports `cancelled`; aborting mid-stream closes the provider stream                        | pass   |
| Parallel subagents: disjoint edits succeed; overlapping edits serialised | `tests/integration/subagents.test.ts` (3) plus fixture task 5/5: disjoint parallel edits apply; overlapping writes are serialised under `serialize` and refused under `reject`; no interleaving                                                         | pass   |
| Model selection only through `resolveModelForTier`                       | `tests/unit/model-selection.test.ts` (2) scans `packages/*/src` and `apps/*/src`, plus ESLint `freebuff/no-hardcoded-model`. Rule verified by a deliberate violation: `error ... Do not hardcode model id "deepseek-v4-pro"`                            | pass   |

Defect found and fixed by this gate: `withTimeout` created its own abort controller and never heard the
run's cancellation, so a cancelled run left its subprocess alive until the tool deadline. The timeout
now forwards the parent signal (`DECISIONS.md` D14); the cancellation test asserts process death.

### Phase 2 — passed 2026-11-18

`bun run check` and `bun run build` clean: 28 test files, 172 tests (35 new), 0 lint warnings, no `tsc`
errors. Runtime smoke under Bun: `freebuff --help`, `freebuff config`, `freebuff dev` + `GET /v1/health`

- `POST /v1/auth/login`, and the TUI's initial frame (renderer boots and draws the sign-in screen).

| Gate requirement                              | Evidence                                                                                                                                                                                                                                                                           | Result |
| --------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| Auth                                          | `tests/integration/cli/gate.test.ts`: `signIn` against the live HTTP platform returns a token, config is written atomically, `auth.me()` resolves the same user; a second account gets 404 for the first account's session and an empty session list                               | pass   |
| Project picker                                | Same test: the checkout registers once via `resolveProject`, `projects.list()` returns exactly that project, and it is still listed after a platform restart                                                                                                                       | pass   |
| Multi-file edit                               | One agent turn writes `a.ts` and `b.ts` through `write_file`; both files on disk hold the new contents and the run completes                                                                                                                                                       | pass   |
| Terminal command                              | The same turn runs `printf broker-stdout-marker` through `run_command`; the tool result is ok, and a `process.stdout.write` spy proves the output never reached the CLI's stdio (`tests/integration/cli/broker.test.ts` covers piped stdio, scrubbed env, timeout and abort kills) | pass   |
| Chat persistence                              | `sessions.get()` returns the stored messages immediately; after closing and restarting the platform on the same state file, `sessions.list()` and `sessions.get()` still return the session, message count and project id                                                          | pass   |
| Server-authoritative quota + ads (supporting) | `packages/quota` 16 tests: window cut at local midnight, DST and half-hour zones, credit consumption, daily denial, no rollover, client mirror cannot extend time. `freebuff dev` + login smoke returned a real session and a `Sponsored` selection for a free-tier account        | pass   |

## Known gaps / risks

- The TUI is typechecked and boots to its first frame, but no interactive pty session is driven in
  tests (no terminal here). Key handling, scrollback and mid-run cancellation in the UI are unverified
  interactively; the flows behind them are covered headlessly.
- The platform API used by the CLI is the Phase 2 local service (`apps/cli/src/platform`), not a hosted
  multi-tenant API; Phase 3 replaces the deployment behind the same SDK contract (`DECISIONS.md` D16).
- Sign-in is an email identity exchange, not OAuth or magic links; real credential flows arrive in
  Phases 3–5.
- Terminal commands are one-shot `bash -lc` runs with captured output, not a streaming pty
  (`DECISIONS.md` D18).
- Docker containers cannot be booted in this environment (no daemon); the sandbox image is exercised by
  CI's `sandbox-image` job, not locally.
- `code-map` uses a regex indexer rather than tree-sitter (`DECISIONS.md` D15).
- Provider pricing/model ids were verified on 2026-11-17 and must be refreshed again before Phase 5
  billing math is trusted (`DECISIONS.md` D12).
- Convex, GitHub OAuth and Twilio credentials are still unprovisioned; `config/env.ts` keeps them
  optional until their phase.

## Next action

Await approval to start **Phase 3 — Cloud sandbox + GitHub import + preview** (gate: public repo → live
preview URL < 120 s, isolation proven).

## Workspace inventory

Every surface and package directory in the spec exists. Directories whose phase has not started
contain a `README.md` stating scope + phase gate and nothing else (no stub modules, `DECISIONS.md` D6).

| Path                             | Kind | Phase | Contents today          |
| -------------------------------- | ---- | ----- | ----------------------- |
| `apps/cli/`                      | app  | 2     | implemented + 13 tests  |
| `apps/desktop/`                  | app  | 5     | placeholder `README.md` |
| `apps/web/`                      | app  | 4     | placeholder `README.md` |
| `apps/cloud/`                    | app  | 3     | placeholder `README.md` |
| `packages/shared/`               | pkg  | 0     | implemented + 84 tests  |
| `packages/agent-runtime/`        | pkg  | 1     | implemented + 22 tests  |
| `packages/llm-providers/`        | pkg  | 1     | implemented + 22 tests  |
| `packages/code-map/`             | pkg  | 1     | implemented + 7 tests   |
| `packages/quota/`                | pkg  | 2/5   | implemented + 16 tests  |
| `packages/sdk/`                  | pkg  | 2     | implemented + 6 tests   |
| `packages/sandbox-orchestrator/` | pkg  | 3     | placeholder `README.md` |
| `packages/db/`                   | pkg  | 4     | placeholder `README.md` |
| `packages/auth/`                 | pkg  | 3–5   | placeholder `README.md` |
| `packages/ads/`                  | pkg  | 5     | placeholder `README.md` |
