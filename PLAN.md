# PLAN — freebuff-class platform

Target layout is the one in the build prompt (§3). The git repository root **is** the monorepo root
(`freebuff-clone/`); see `DECISIONS.md` D1.

Legend: each phase ends at a **gate**. The gate suite is run, diffs summarised, risks listed, and work
**stops for approval** before the next phase starts (§7). Status lives in `PROGRESS.md`.

---

## Phase 0 — Foundation · gate: `bun run check` clean, CI green on the skeleton

| Deliverable                | Paths                                                                                             |
| -------------------------- | ------------------------------------------------------------------------------------------------- |
| Bun workspace monorepo     | `package.json`, `tsconfig.base.json`, `tsconfig.json`, `bun.lock`                                 |
| Strict TS + lint + format  | `eslint.config.mjs`, `.prettierrc.json`, `.editorconfig`                                          |
| Test runner                | `vitest.config.ts`, colocated `packages/*/src/**/*.test.ts`, `tests/`                             |
| CI pipeline                | `.github/workflows/ci.yml` (lint → typecheck → unit → build → compose config)                     |
| Local infra                | `infra/docker-compose.yml` (Postgres 16 + hardened sandbox runtime), `infra/sandbox/Dockerfile`   |
| Sandbox runtime health API | `infra/sandbox/entrypoint.ts`, `infra/sandbox/health.ts`                                          |
| Shared domain types        | `packages/shared/src/types/{agent,tool,session,quota,ad,model,tier,sandbox,api,json,ids,time}.ts` |
| Config-driven defaults     | `packages/shared/src/config/{models,tiers,countries,agent,env}.ts`                                |
| Resilience + secrecy utils | `packages/shared/src/utils/{errors,result,retry,time,redact,logger}.ts`                           |
| Governance docs            | `README.md`, `PLAN.md`, `DECISIONS.md`, `PROGRESS.md`                                             |

Gate evidence: `bun run check` (format, lint, typecheck, unit) + `bun run build` + `docker compose config`.

## Phase 1 — Agent runtime · gate: 5/5 scripted fixture-repo tasks produce the expected diffs

- `packages/agent-runtime/src/{loop,registry,streaming,cancellation,parsing,subagents}.ts` + tests.
- `packages/llm-providers/src/{index,deepseek,openai,anthropic,http}.ts` — shared streaming HTTP
  client (timeout, retry, breaker), provider-specific request/response mapping, tier-driven selection.
- `packages/code-map/src/{indexer,graph,query}.ts` — ripgrep-assisted symbol extraction + graph queries.
- Tool implementations in `packages/agent-runtime/src/tools/{read-file,write-file,edit-file,multi-edit,search,shell,web-fetch,code-map,delegate}.ts`;
  shell execution delegated to `packages/sandbox-orchestrator`.
- Deterministic harness: `tests/integration/agent/{tasks.ts,harness.ts}` replaying recorded LLM
  responses against `tests/fixtures/repos/*`, asserting file diffs.

## Phase 2 — CLI · gate: auth → project picker → multi-file edit → terminal command → persistence demo

- `apps/cli/src/{index.tsx,commands.ts,app.tsx}` (Commander + OpenTUI/React).
- `apps/cli/src/{api,state,queries}.ts` (TanStack Query), `apps/cli/src/terminal/broker.ts`
  (pty/child-process broker that never shares agent stdio), `apps/cli/src/ui/{sponsored-slot,quota-bar}.tsx`.
- `packages/quota/src/{window,tracker,client}.ts` — server-authoritative windows, client UX mirror.
- `packages/sdk/src/index.ts` — platform HTTP client used by CLI/desktop/web/cloud.

## Phase 3 — Cloud sandbox · gate: public GitHub repo → reachable preview < 120 s, isolated

- `packages/auth/src/github/*` (OAuth app flow, installation tokens).
- `packages/sandbox-orchestrator/src/{docker,firecracker,provider,lifecycle,detect-preview}.ts`.
- `apps/cloud/*` dashboard, `infra/sandbox-proxy/*` egress allowlist proxy.
- Isolation tests: `tests/integration/sandbox/{network,fs,resources}.test.ts`.

## Phase 4 — Web app builder · gate: one prompt → deployed app (auth + DB + storage + URL + eject)

- `packages/db/src/{schema,migrations,client}.ts` (Convex app-builder backend + Postgres metadata).
- `packages/auth/src/{magic-link,phone,oauth}.ts`.
- `apps/web/*` builder UI, deploy pipeline, `packages/sdk` eject endpoint.
- `tests/e2e/builder.spec.ts` (Playwright).

## Phase 5 — Monetization, desktop, hardening · gate: quota + ads + paid tier + signed installers

- `packages/ads/src/{inventory,targeting,render}.ts`, sponsored slots in CLI/desktop/web.
- `packages/quota/src/country.ts` (uses `packages/shared/src/config/countries.ts`), phone verification.
- `apps/desktop/*` Electron shell + `infra/signing/*` (macOS notarization, Windows Authenticode).
- Security review: `tests/integration/security/*` (escape attempts, OWASP top 10, secret scanning).
- `packages/sdk/README.md` public API documentation.

---

## Cross-cutting rules applied from Phase 0

- Server-authoritative quota and ads; client checks are UX only.
- Every external call: timeout, retry with backoff, circuit breaker (`utils/retry.ts`).
- Secrets only from env/secret manager, validated by `config/env.ts`; logger redacts prompts, code and
  credentials (`utils/redact.ts`).
- Sandboxed execution assumes hostile input: read-only rootfs, dropped capabilities, no-new-privileges,
  per-tenant tmpfs, egress policy types from day one.
