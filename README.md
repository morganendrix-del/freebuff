# freebuff-clone

An ad-supported, multi-surface AI coding platform: one agent runtime shared by a terminal client, a
desktop app, a web app builder and a cloud sandbox. Phase-by-phase plan in [PLAN.md](PLAN.md), decisions
in [DECISIONS.md](DECISIONS.md), status in [PROGRESS.md](PROGRESS.md).

## Layout

```
apps/
  cli/                  OpenTUI + React terminal client           (Phase 2)
  desktop/              Electron wrapper around the CLI core       (Phase 5)
  web/                  App Builder frontend                       (Phase 4)
  cloud/                Sandbox dashboard + preview manager        (Phase 3)
packages/
  agent-runtime/        loop, tools, subagents, streaming          (Phase 1)
  llm-providers/        DeepSeek, OpenAI, Anthropic shims          (Phase 1)
  code-map/             symbol graph / repo indexer                (Phase 1)
  sandbox-orchestrator/ container + microVM lifecycle              (Phase 3)
  db/                   app-builder schema + migrations            (Phase 4)
  auth/                 OAuth, magic links, phone OTP               (Phase 3–5)
  quota/                server-authoritative hour tracker          (Phase 2/5)
  ads/                  inventory, contextual targeting, rendering (Phase 5)
  sdk/                  public platform client                     (Phase 2)
  shared/               domain types, config, resilience utils     (Phase 0)
infra/                  compose, sandbox image, IaC                 (Phase 0+)
tests/                  integration, e2e, load, fixtures
```

## Requirements → where they live

| Spec requirement                        | Implementation                                                     |
| --------------------------------------- | ------------------------------------------------------------------ |
| Agent loop, tools, subagents, streaming | `packages/agent-runtime`, contracts in `packages/shared/src/types` |
| Model-agnostic providers                | `packages/llm-providers` + `packages/shared/src/config/models.ts`  |
| Code-map symbol graph                   | `packages/code-map`                                                |
| CLI, terminal broker, quota UX          | `apps/cli`, `packages/quota`                                       |
| Desktop packaging + signing             | `apps/desktop`, `infra/signing`                                    |
| Cloud sandbox + shareable previews      | `packages/sandbox-orchestrator`, `apps/cloud`, `infra/`            |
| Web app builder + eject                 | `apps/web`, `packages/db`, `packages/auth`, `packages/sdk`         |
| Ads, quota, phone verification, tiers   | `packages/ads`, `packages/quota`, `packages/shared/src/config`     |

## Development

Requires Bun >= 1.2 and Docker (for local Postgres + sandbox runtime).

```bash
bun install          # install workspace dependencies
cp .env.example .env # fill in only what the phase you run needs
bun run check        # format:check + lint + typecheck + unit tests
bun run build        # bundle packages/shared
bun run infra:up     # Postgres 16 + sandbox runtime
```

`bun run check` is the local mirror of the CI gate in `.github/workflows/ci.yml`.

## Working agreement

- Every phase ships tests; no phase closes with failing or skipped tests.
- Quota and ad decisions are server-authoritative; clients only mirror state for UX.
- Nothing logs prompts, source code, tokens or credentials (`packages/shared/src/utils/logger.ts`).
- Sandboxed execution assumes hostile input.
