# Architecture decisions

One entry per meaningful fork in the road. Ambiguities are resolved toward the simplest implementation
consistent with the product spec (§2) and recorded here.

## D1 — Repository root is the monorepo root

The spec shows `freebuff-clone/apps/...`. The git repository already _is_ the project, so `apps/`,
`packages/`, `infra/` and `tests/` live at the repository root instead of inside a nested
`freebuff-clone/` directory. Identical layout, no wrapper folder.

## D2 — Bun workspaces, no build step for library packages

All packages are consumed as TypeScript source via `exports: "./src/index.ts"`. Bun and Vitest resolve
it directly; `tsc --noEmit` typechecks the whole graph. Only publishable artifacts get a real build
(`packages/shared` bundles with `bun build` to prove the toolchain works). Avoids stale `dist/` in dev.

## D3 — Strictness beyond `strict: true`

`noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `noImplicitReturns`,
`noFallthroughCasesInSwitch`, `noUnused*`, plus ESLint `strictTypeChecked` with `no-explicit-any`,
`no-non-null-assertion` and `no-console` as errors. `any` is unrepresentable in committed code; unknown
data enters as `unknown` and is narrowed or validated with Zod.

## D4 — Domain types before implementation

Phase 0 ships the shared vocabulary (Agent, Tool, Session, Quota, Ad, Model, Sandbox, Api) so later
packages cannot drift. Types encode product rules structurally where possible: `AdCreative.label` is
the literal `"Sponsored"`, `SandboxSpec.readOnlyRootFilesystem` is the literal `true`, `QuotaPolicy.resetAtLocalMidnight`
is the literal `true`.

## D5 — Model and quota configuration is data, never code

`config/models.ts` holds the model catalogue and tier→model policy; `config/tiers.ts` holds
entitlements; `config/countries.ts` holds per-country free-tier hours with a default of 5 h and a US
value of 30 h. All three are overrideable from environment (`MODEL_CATALOG_JSON`,
`FREE_TIER_DAILY_HOURS_JSON`) through `config/env.ts`, so no model name or country quota is hardcoded
in logic (anti-pattern §8).

## D6 — Unbuilt packages are documentation-only placeholders

`apps/cli`, `apps/desktop`, `apps/web`, `apps/cloud` and the not-yet-started packages contain a
`README.md` stating scope + the phase whose gate delivers them, and nothing else. No stub modules, no
`TODO` implementation files: §8 forbids stub backends in shipped paths, and empty packages would fail
typecheck/lint for no benefit. Each phase adds its real package manifest when it starts.

## D7 — Sandbox runtime: hardened container locally, microVM in production

Local dev runs `infra/sandbox/Dockerfile` under compose with `read_only`, `cap_drop: ALL`,
`no-new-privileges`, tmpfs `/workspace` and PID/memory/CPU limits. Production swaps the isolation
boundary to Firecracker microVMs behind the same `SandboxSpec`/`SandboxHandle` contract
(`packages/sandbox-orchestrator`). Docker bridge networking is only a local convenience: production
enforces `EgressPolicy` through an allowlist proxy, and the type carries `deny_all` as the default.

## D8 — Sandbox runtime health surface only in Phase 0

`infra/sandbox` exposes `GET /health` and `GET /info` — enough for compose healthchecks and readiness
gating. Execution endpoints (`/exec`, `/files`) belong to Phase 3 with the orchestrator and its
isolation tests, so no half-built execution surface exists.

## D9 — Zod at the process boundary

Zod is used for environment/config validation only (`config/env.ts`), not for the core loop. Tool input
schemas stay JSON Schema (`types/json.ts`) because that is what providers consume; Phase 1 validates
tool calls against those schemas deterministically.

## D10 — Graceful timezone handling for quota windows

`utils/time.ts` derives local day keys and the next local midnight from IANA time zones using `Intl`,
with iterative offset resolution so DST transitions are handled. The platform never assumes the server
timezone; quota windows always carry their `timeZone`.
