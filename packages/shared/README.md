# @freebuff/shared

The vocabulary every surface speaks: agent, tool, session, quota, ad, model, sandbox and API types,
plus the config tables that make model/plan/country behaviour data rather than code, and the
resilience/redaction utilities every external call must use.

## What lives here

| Area                       | Files                                          |
| -------------------------- | ---------------------------------------------- |
| Domain types               | `src/types/*.ts`                               |
| Config tables              | `src/config/{models,tiers,countries,agent}.ts` |
| Environment validation     | `src/config/env.ts`                            |
| Errors / results           | `src/utils/{errors,result}.ts`                 |
| Retry / breaker / timeout  | `src/utils/retry.ts`                           |
| Time zones and day windows | `src/utils/time.ts`                            |
| Secret redaction + logging | `src/utils/{redact,logger}.ts`                 |

## Rules

- Types are the contract: no `any`, no optional `undefined` smuggling
  (`exactOptionalPropertyTypes` is on).
- Product rules are encoded structurally where possible — `AdCreative.label` is the literal
  `"Sponsored"`, `SandboxSpec.readOnlyRootFilesystem` is the literal `true`,
  `QuotaPolicy.resetAtLocalMidnight` is the literal `true`.
- `config/*` is data. Anything that ops may need to change (models, prices, country hours, tier
  entitlements, loop limits) belongs there and is overridable from the environment.

```bash
bun run build   # bundle to dist/ (proves the package builds)
bun run test    # colocated vitest suites
```
