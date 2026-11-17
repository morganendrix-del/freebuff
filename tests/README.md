# tests

Cross-package tests live here; unit tests live next to the code they cover (`**/src/**/*.test.ts`).

| Directory      | Runner     | Phase | Purpose                                                 |
| -------------- | ---------- | ----- | ------------------------------------------------------- |
| `fixtures/`    | —          | 1     | Small repos the agent must edit, with expected diffs.   |
| `integration/` | Vitest     | 1, 3  | Agent harness over fixtures; sandbox isolation suites.  |
| `e2e/`         | Playwright | 4     | Builder and dashboard flows against a running platform. |
| `load/`        | k6         | 5     | Quota/agent concurrency load tests.                     |

Test doubles are allowed here and only here; production paths never contain mocks.
