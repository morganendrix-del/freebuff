# PROGRESS

Updated at the end of every phase and whenever a gate result changes.

## Phase status

| Phase | Scope                                   | Status      | Gate                                                     |
| ----- | --------------------------------------- | ----------- | -------------------------------------------------------- |
| 0     | Foundation: monorepo, CI, types, infra  | gate passed | `bun run check` clean + CI green on skeleton             |
| 1     | Agent runtime + providers + code map    | gate passed | 5/5 scripted fixture tasks produce expected diffs        |
| 2     | CLI (OpenTUI/React) + terminal broker   | not started | auth → picker → multi-file edit → command → persistence  |
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
| `bun run test` (Vitest)                                                                                  | pass — 11 files, 66 tests (84 after the Phase 1 catalogue/test additions to `shared`)                                                                        |
| `bun run build` (`bun build packages/shared`)                                                            | pass — `dist/index.js` 25.21 KB                                                                                                                              |
| `docker compose -f infra/docker-compose.yml config`                                                      | pass                                                                                                                                                         |
| Sandbox image build + `/health` boot                                                                     | CI only — no Docker daemon locally. The `sandbox-image` job builds the image and probes `/health`, and had to be fixed once (entrypoint moved out of tmpfs). |
| GitHub Actions CI                                                                                        | **green** on `phase-0/foundation` after the `sandbox-image` fix (`17f1291`).                                                                                 |

### Phase 1 — passed 2026-11-18

`bun run check` and `bun run build` are clean: 21 test files, 137 tests, 0 lint warnings, no `tsc`
errors.

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

## Known gaps / risks

- Docker containers cannot be booted in this environment (no daemon); the sandbox image is exercised by
  CI's `sandbox-image` job, not locally.
- `code-map` uses a regex indexer rather than tree-sitter (`DECISIONS.md` D15); results are correct for
  the supported languages but shallower than a real parse.
- Provider pricing/model ids were verified on 2026-11-17 and must be refreshed again before Phase 5
  billing math is trusted (`DECISIONS.md` D12).
- Convex, GitHub OAuth and Twilio credentials are still unprovisioned; `config/env.ts` keeps them
  optional until their phase.
- Placeholder packages/apps carry documentation only (`DECISIONS.md` D6).

## Next action

Await approval to start **Phase 2 — CLI + terminal broker** (gate: auth → picker → multi-file edit →
command → persistence).

## Workspace inventory

Every surface and package directory in the spec exists. Directories whose phase has not started
contain a `README.md` stating scope + phase gate and nothing else (no stub modules, `DECISIONS.md` D6).

| Path                             | Kind | Phase | Contents today          |
| -------------------------------- | ---- | ----- | ----------------------- |
| `apps/cli/`                      | app  | 2     | placeholder `README.md` |
| `apps/desktop/`                  | app  | 5     | placeholder `README.md` |
| `apps/web/`                      | app  | 4     | placeholder `README.md` |
| `apps/cloud/`                    | app  | 3     | placeholder `README.md` |
| `packages/shared/`               | pkg  | 0     | implemented + 84 tests  |
| `packages/agent-runtime/`        | pkg  | 1     | implemented + 22 tests  |
| `packages/llm-providers/`        | pkg  | 1     | implemented + 22 tests  |
| `packages/code-map/`             | pkg  | 1     | implemented + 7 tests   |
| `packages/sandbox-orchestrator/` | pkg  | 3     | placeholder `README.md` |
| `packages/db/`                   | pkg  | 4     | placeholder `README.md` |
| `packages/auth/`                 | pkg  | 3–5   | placeholder `README.md` |
| `packages/quota/`                | pkg  | 2/5   | placeholder `README.md` |
| `packages/ads/`                  | pkg  | 5     | placeholder `README.md` |
| `packages/sdk/`                  | pkg  | 2     | placeholder `README.md` |
