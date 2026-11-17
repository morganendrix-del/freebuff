# PROGRESS

Updated at the end of every phase and whenever a gate result changes.

## Phase status

| Phase | Scope                                   | Status      | Gate                                                     |
| ----- | --------------------------------------- | ----------- | -------------------------------------------------------- |
| 0     | Foundation: monorepo, CI, types, infra  | gate passed | `bun run check` clean + CI green on skeleton             |
| 1     | Agent runtime + providers + code map    | not started | 5/5 scripted fixture tasks produce expected diffs        |
| 2     | CLI (OpenTUI/React) + terminal broker   | not started | auth → picker → multi-file edit → command → persistence  |
| 3     | Cloud sandbox + GitHub import + preview | not started | public repo → live preview URL < 120 s, isolation proven |
| 4     | Web app builder + eject to GitHub       | not started | one prompt → deployed app with auth, DB, storage, eject  |
| 5     | Monetization + desktop + hardening      | not started | free tier under quota, ads, paid tier, signed installers |

## Gate results

### Phase 0 — passed 2026-11-17

| Check                                                                                                    | Result                                                                                                                                            |
| -------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `bun run format:check`                                                                                   | pass                                                                                                                                              |
| `bun run lint` (ESLint strictTypeChecked, 0 warnings)                                                    | pass                                                                                                                                              |
| `bun run typecheck` (`tsc --noEmit`, strict + `noUncheckedIndexedAccess` + `exactOptionalPropertyTypes`) | pass                                                                                                                                              |
| `bun run test` (Vitest)                                                                                  | pass — 11 files, 66 tests                                                                                                                         |
| `bun run build` (`bun build packages/shared`)                                                            | pass — `dist/index.js` 25.21 KB                                                                                                                   |
| `docker compose -f infra/docker-compose.yml config`                                                      | pass                                                                                                                                              |
| Sandbox image build + `/health` boot                                                                     | **not run** — no Docker daemon in this environment; CI `compose` job validates config. Build/health boot must be confirmed where a daemon exists. |
| GitHub Actions CI                                                                                        | not yet run — the workflow is committed but this phase was not pushed.                                                                            |

## Known gaps / risks

- Docker containers cannot be booted here (no daemon), so the sandbox image and its healthcheck are
  unverified beyond `docker compose config`. First Phase 3 task will boot them on a host with Docker.
- Placeholder packages/apps carry documentation only (see `DECISIONS.md` D6); no stub code ships.
- Convex, GitHub OAuth and Twilio credentials are not provisioned; `config/env.ts` treats them as
  optional until their phase.
- Provider pricing/model ids in `config/models.ts` need refresh against live provider catalogues before
  Phase 1 billing math is trusted.

## Next action

Await approval to start **Phase 1 — Agent runtime** (gate: 5/5 scripted fixture tasks produce the
expected file diffs).

## Workspace inventory (pre-flight check)

Every surface and package directory in the spec exists. Directories whose phase has not started
contain a `README.md` stating scope + phase gate and nothing else (no stub modules, `DECISIONS.md` D6).

| Path                             | Kind | Phase | Contents today          |
| -------------------------------- | ---- | ----- | ----------------------- |
| `apps/cli/`                      | app  | 2     | placeholder `README.md` |
| `apps/desktop/`                  | app  | 5     | placeholder `README.md` |
| `apps/web/`                      | app  | 4     | placeholder `README.md` |
| `apps/cloud/`                    | app  | 3     | placeholder `README.md` |
| `packages/shared/`               | pkg  | 0     | implemented + 66 tests  |
| `packages/agent-runtime/`        | pkg  | 1     | placeholder `README.md` |
| `packages/llm-providers/`        | pkg  | 1     | placeholder `README.md` |
| `packages/code-map/`             | pkg  | 1     | placeholder `README.md` |
| `packages/sandbox-orchestrator/` | pkg  | 3     | placeholder `README.md` |
| `packages/db/`                   | pkg  | 4     | placeholder `README.md` |
| `packages/auth/`                 | pkg  | 3–5   | placeholder `README.md` |
| `packages/quota/`                | pkg  | 2/5   | placeholder `README.md` |
| `packages/ads/`                  | pkg  | 5     | placeholder `README.md` |
| `packages/sdk/`                  | pkg  | 2     | placeholder `README.md` |
