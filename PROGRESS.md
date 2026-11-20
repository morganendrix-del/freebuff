# PROGRESS

Updated at the end of every phase and whenever a gate result changes.

## Phase status

| Phase | Scope                                   | Status      | Gate                                                     |
| ----- | --------------------------------------- | ----------- | -------------------------------------------------------- |
| 0     | Foundation: monorepo, CI, types, infra  | gate passed | `bun run check` clean + CI green on skeleton             |
| 1     | Agent runtime + providers + code map    | gate passed | 5/5 scripted fixture tasks produce expected diffs        |
| 2     | CLI (OpenTUI/React) + terminal broker   | gate passed | auth → picker → multi-file edit → command → persistence  |
| 3     | Cloud sandbox + GitHub import + preview | gate passed | public repo → live preview URL < 120 s, isolation proven |
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

`bun run check` and `bun run build` clean: 30 test files, 179 tests (42 new), 0 lint warnings, no `tsc`
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

### Phase 2 post-gate fixes — 2026-11-18

Two defects found on review, fixed with tests (179 total, 7 new):

| Fix                                                    | Behaviour now                                                                                                                                                                                                                                                                 | Evidence                                                                                                                                                                                                                                              |
| ------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| First-time user could reach a dead end                 | An account with no projects gets the current directory registered automatically and opens chat in it; an account with other projects sees a picker that also offers **Register this directory**; signing in from the TUI loads the workspace instead of leaving an empty view | `tests/integration/cli/bootstrap.test.ts` (4 tests: fresh register, no duplicate, picker + on-demand register, view planning). TUI smoke: first launch printed `Registered <repo> for this directory.`                                                |
| Provider was hardcoded (`"deepseek"`) in the TUI entry | `runChatTurn` takes a `providerFactory` and asks it for the **resolved model's** provider; a factory returning a mismatched provider is rejected with `Provider "x" cannot serve model "y"`                                                                                   | `tests/integration/cli/provider-selection.test.ts` (3 tests: factory called with the resolved provider, model in the provider request matches the resolution, mismatch rejected, plus a source scan proving no provider id literal in `apps/cli/src`) |

### Phase 3 — passed 2026-11-19

`bun run check` and `bun run build` clean: 43 test files, 241 passed + 1 skipped (the Docker-provider
suite, which requires a real daemon and runs in CI), 0 lint warnings, no `tsc` errors.

| Gate requirement (expanded)                    | Evidence                                                                                                                                                                                                                                                                                                                         | Result |
| ---------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| Public GitHub repo → reachable preview < 120 s | `tests/integration/sandbox/gate.test.ts`: bare-clone fixture → clone, stack detect, install, launch, probe → `status: "ready"` in **982 ms**; preview returns "freebuff preview ok"; stage timings sum to the measured total. Real clone of `https://github.com/octocat/Hello-World.git` through the runtime succeeded in 745 ms | pass   |
| Preview is served through the cloud proxy      | `apps/cloud/test/server.test.ts`: `POST /v1/sandboxes` → 202, poll to `ready`, `GET /preview/:id/` returns the app HTML, deep paths and query strings forwarded, preview stops answering (`409`) after stop                                                                                                                      | pass   |
| Network isolation                              | `tests/integration/sandbox/network.test.ts` (5): allowlisted `host:port` proxied, same host on another port denied `403`, unknown host denied, `CONNECT` tunnel denied/allowed, `deny_all` blocks even allowlisted hosts, denials recorded. Compose network is `internal: true`; sandbox uses the proxy variables only           | pass   |
| Filesystem isolation                           | `tests/integration/sandbox/fs.test.ts` (5) + `workspace.test.ts` (5): `..`, absolute paths, symlink to a host file and `sub/../../x` all rejected with `403`; host file unchanged; 600 KiB read refused; read-only rootfs, cap-drop and tmpfs asserted in `docker.test.ts`                                                       | pass   |
| Resource isolation                             | `tests/integration/sandbox/resources.test.ts` (6): 400 ms timeout kills `sleep 30` (no output), 4 KiB output cap on `yes`, `ulimit -f` truncates a 5 MB write (SIGXFSZ), allocation under a 256 MB limit dies, over-limit `timeoutMs` rejected by the runtime, oversized body `413`                                              | pass   |
| GitHub auth                                    | `packages/auth/test/github.test.ts` (11): PKCE challenge derivation, consent URL params, state mismatch rejected, code exchange with verifier, OAuth error mapping, RS256 JWT verified with the public key, installation-token exchange carries the JWT and the token never appears in messages or argv                          | pass   |
| Container path runs against a real daemon      | CI `sandbox-image` (boot + `/exec`, `/files`, traversal `403`, preview detect + proxy, unprivileged uid, read-only rootfs) and `sandbox-docker-provider` (`DockerProvider.create/exec/files/stop`)                                                                                                                               | CI     |

Runtime smoke (real processes, no test harness): `bun run sandbox:runtime` answered `/health`,
rejected unauthenticated `/exec` with `401`, ran `id -u` (uid 145089335, not root) with cwd in the
workspace, returned `403` for `../escaped.txt`, cloned a real GitHub repository, detected a preview on
port 34309 and proxied it. `bun run cloud` then imported a repository through HTTP (`401` without the
token), reached `ready` in 864 ms (`cloning 292 ms · installing 260 ms · starting 309 ms`), served the
preview at `/preview/<id>/`, served the dashboard (`200`, 8.3 KB) and stopped the sandbox.

CI run `44651911401` on `d46629b` concluded **success**: lint, typecheck, unit tests, build, compose
config, `sandbox-image` and `sandbox-docker-provider` all green.

Three defects were found and fixed by running this gate rather than by reading the code:

1. `DockerProvider` let the spec's default image override its configured image, so the container was
   created from an image that did not exist in CI. The provider now owns the image, because it must
   contain the runtime's control API.
2. Container tmpfs mounts were root-owned while the runtime runs as uid 1000, so the first file write
   would have failed. Mounts now carry `uid=1000,gid=1000`, and creation probes the workspace.
3. Docker does not publish ports on an internal network, so the control API was unreachable. The
   control channel is now a Unix socket in a directory bind-mounted at `/run/sandbox`, with the socket
   made connectable across uids (`0666`) and the per-run bearer token as the authorization boundary.

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
- Convex, GitHub OAuth/App and Twilio credentials are still unprovisioned; `config/env.ts` keeps them
  optional until their phase. The GitHub flows are proven against a fake transport, not live GitHub
  credentials.
- No Docker daemon exists in the development environment, so the container and Docker-provider paths
  are exercised by CI, not locally; Firecracker needs a KVM host and is configured but unexercised
  outside staging (`DECISIONS.md` D21).
- The gate measures a local mirror (`cloneUrl`) plus a verified real `git clone`; it does not measure
  a large real application's install time from github.com (120 s budget, no public app with a known
  install time was pinned).
- The dashboard was checked only as HTML (`200`, contains the import form); it was not opened in a
  browser, so layout and interactions are visually unverified.

## Next action

Await approval to start **Phase 4 — Web app builder** (gate: one prompt → deployed app with auth, DB,
storage, URL and GitHub eject).

## Workspace inventory

Every surface and package directory in the spec exists. Directories whose phase has not started
contain a `README.md` stating scope + phase gate and nothing else (no stub modules, `DECISIONS.md` D6).

| Path                             | Kind | Phase | Contents today          |
| -------------------------------- | ---- | ----- | ----------------------- |
| `apps/cli/`                      | app  | 2     | implemented + 20 tests  |
| `apps/desktop/`                  | app  | 5     | placeholder `README.md` |
| `apps/web/`                      | app  | 4     | placeholder `README.md` |
| `apps/cloud/`                    | app  | 3     | implemented + 3 tests   |
| `packages/shared/`               | pkg  | 0     | implemented + 84 tests  |
| `packages/agent-runtime/`        | pkg  | 1     | implemented + 22 tests  |
| `packages/llm-providers/`        | pkg  | 1     | implemented + 22 tests  |
| `packages/code-map/`             | pkg  | 1     | implemented + 7 tests   |
| `packages/quota/`                | pkg  | 2/5   | implemented + 16 tests  |
| `packages/sdk/`                  | pkg  | 2     | implemented + 6 tests   |
| `packages/sandbox-orchestrator/` | pkg  | 3     | implemented + 35 tests  |
| `packages/db/`                   | pkg  | 4     | placeholder `README.md` |
| `packages/auth/`                 | pkg  | 3–5   | GitHub + 11 tests       |
| `packages/ads/`                  | pkg  | 5     | placeholder `README.md` |
