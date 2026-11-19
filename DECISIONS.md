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

## D11 — Shell execution exists only behind the `CommandExecutor` port

The agent's `run_command` tool never spawns a process itself. It calls a `CommandExecutor` supplied by
the host (`packages/agent-runtime/src/tools/workspace.ts`) and fails with `permission_denied` when none
is attached, so no unsandboxed execution path exists in shipped code. Phase 3 supplies the sandbox
orchestrator behind the same port. Tests inject a local `node:child_process` executor to prove
cancellation at the OS level; that executor lives in test code only.

## D12 — Model catalogue refreshed against live provider docs (2026-11-17)

`config/models.ts` was re-checked against the providers' published catalogues and API references on
2026-11-17 (`MODEL_CATALOG_METADATA.retrievedAt`). Active ids: DeepSeek `deepseek-flash` (V4.1, the
free default) and `deepseek-v4-pro`; Anthropic `claude-sonnet-5-5` (pro default) and `claude-opus-5-5`;
OpenAI `gpt-6.1-sol` and `gpt-6-astra`. Legacy `deepseek-chat` / `deepseek-reasoner` were retired on
2026-07-24 and are intentionally absent. Context windows and per-million-token prices were updated from
the same sources, and `ModelPricing` gained optional off-peak fields because DeepSeek publishes
discounted windows. Refresh before Phase 5 billing math is trusted.

## D13 — Model choice is enforced mechanically, not by convention

Two guards keep model selection on `resolveModelForTier`: an ESLint rule `freebuff/no-hardcoded-model`
(defined inline in `eslint.config.mjs`) that fails any string literal matching a provider model id in
`packages/*/src` or `apps/*/src`, and `tests/unit/model-selection.test.ts`, which scans those sources
for the same pattern and asserts the catalogue is the only module resolving a tier. The catalogue and
test files are the only exclusions, so a new call site cannot bypass the rule.

## D14 — Tool timeouts inherit run cancellation

`withTimeout` in `utils/retry.ts` accepts an optional parent `AbortSignal` and aborts the operation's
signal when the parent aborts. `ToolRegistry` passes the run signal, so cancelling a run reaches an
in-flight tool (killing its subprocess or closing its stream) instead of waiting for the tool's own
timeout. This was a real defect found by the Phase 1 cancellation gate: previously a cancelled run left
`sleep 60` alive until the tool deadline.

## D15 — Code map indexer is regex-based behind a stable shape

`packages/code-map` extracts symbols and references with anchored regular expressions per language
rather than a tree-sitter parse. It is deterministic, dependency-free and fast enough for the agent's
`code_map_query` tool. Because callers only see `CodeMap` / `CodeMapQueryResult`, a tree-sitter backend
can replace `indexRepository` later without changing the tool, its schema or its tests.

## D16 — The Phase 2 platform API lives in `apps/cli/src/platform`

No hosted API exists until Phase 3, but the CLI must not talk to an in-process fake. The CLI therefore
ships a real HTTP service (`startLocalPlatform`, Node `http`, durable JSON store, atomic writes) that
the `freebuff dev` command runs. It issues tokens, owns projects and sessions per user, decides quota
through `@freebuff/quota`, selects ads server-side and brokers terminal commands. `@freebuff/sdk` is
its only client, so Phase 3 can replace the deployment without changing client code; the store is not
a stub — it is the same contract, file-backed. Ownership checks are already enforced (a second account
gets 404 for the first account's session).

## D17 — The CLI runs the agent locally and shells through the broker

Phase 2 keeps the agent loop in-process (`@freebuff/agent-runtime`) against the user's checkout, like a
local coding agent, while quota, history and ads stay server-side. Shell execution still goes through
the `CommandExecutor` port (D11), now backed by the terminal broker over the platform's terminal
channel — so the loop never spawns a process and agent stdio is never mixed with command output. Phase
3 swaps the broker's backend for the sandbox without touching the loop or the tools.

## D18 — Terminal channel is one-shot exec in Phase 2

The broker runs `bash -lc` per command with piped stdio, its own process group, a scrubbed environment
(credential-looking variables removed) and timeout/abort kills of the process group. It returns
captured stdout/stderr rather than streaming a pty; interactive streaming belongs to the sandbox broker
in Phase 3, where the pty lives behind the isolation boundary.

## D19 — SDK transport contract

The client speaks an envelope (`{ ok, data }` / `{ ok, error }`), attaches `x-request-id`, retries
GETs on 408/429/5xx with the shared backoff, and never retries mutations. Timeouts use `withTimeout`.
Errors surface as `SdkError` carrying `apiCode`, `status` and `requestId`, so surfaces can distinguish
auth, quota and transport failures without parsing messages.

## D20 — The sandbox runtime is a package module, not entrypoint script

`infra/sandbox` kept only a health surface in Phase 0 (D8). The execution surface now lives in
`packages/sandbox-orchestrator/src/runtime` and is imported by three callers: the container entrypoint,
the development process provider and the integration tests. It depends on `node:` builtins only
(type-only imports from `@freebuff/shared` are erased), so the image ships without `node_modules`.
`infra/sandbox/entrypoint.ts` is a three-line loader for local runs.

Consequence: enforcement code is identical in tests and production instead of a test-only fake, and
the image is built from the repository root so the package layout survives into `/opt/sandbox`.

## D21 — Three providers, with isolation stated rather than implied

- `DockerProvider` — hardened container (read-only rootfs, tmpfs workspace, cap drop ALL,
  no-new-privileges, non-root user, memory/CPU/PID/nofile limits, internal network). Local and CI path.
- `FirecrackerProvider` — microVM with a read-only rootfs drive, per-sandbox workspace drive and a
  per-VM tap device. Production boundary; needs a KVM host, so it is configured and reviewed here but
  only exercised in staging.
- `ProcessProvider` — ordinary child processes with the same runtime enforcement, for development and
  tests. It has **no kernel boundary** and reports `isolation: "process"`, which the API surfaces.

The `SandboxInstance` contract is identical for all three, so the pipeline, cloud API and preview
proxy do not branch on provider. Hiding the difference would be worse than exposing it: a caller can
never mistake a development sandbox for an isolated one.

## D22 — Egress is enforced by an internal network plus one allowlist proxy

Sandboxes sit on a Docker network with `internal: true` (no default route). The only reachable peer is
`infra/sandbox-proxy`, which answers absolute-form HTTP and `CONNECT`, checks every destination with
`isEgressAllowed` (`deny_all` wins, an empty allowlist denies all, `*.host` covers subdomains) and
returns 403 for the rest. `deny_all` additionally clears every proxy variable. The same policy object
feeds the Firecracker tap rules and is what `SandboxSpec.egress` already encoded in Phase 0.

Proxy variables alone are not a boundary — which is why the network is internal. The process provider
uses the proxy variables and says so in its docs.

## D23 — GitHub credentials never travel in URLs or argv

The clone command is built from a validated URL and branch; an installation token is passed with git's
`http.extraHeader` through `GIT_CONFIG_*` environment variables, so it is absent from argv (`ps`),
shell history and logs. Git runs with `GIT_TERMINAL_PROMPT=0` and `/bin/true` as askpass, so a private
repository cannot make the sandbox prompt or hang.

OAuth uses the authorization-code flow with PKCE and a mandatory `state`; GitHub App requests use a
short-lived RS256 JWT. `GitHubError` exposes status and request id only.

## D24 — Cloud API returns an id immediately and streams progress

`POST /v1/sandboxes` starts the pipeline, waits only until the sandbox exists (provisioned), and
answers `202` with the record. Progress is available through `GET /v1/sandboxes/:id` and an SSE
`/events` route. The dashboard needs no websocket; the pipeline emits status and log events as it
runs.

Previews are public by design but keyed by a 128-bit sandbox id, proxied through the cloud origin, and
physically unable to reach the control API (the preview route only forwards to the dev-server port).

## D25 — Gate timing is measured on the real code path, with a local mirror

The gate fixture is a bare clone of a repository served over `file://`; `CreateSandboxInput.cloneUrl`
exists for mirrors and GitHub Enterprise as well as tests. Clone, detect, install, launch and probe are
the production code paths. A real `https://github.com/octocat/Hello-World.git` clone through the same
runtime was verified manually (745 ms), and the container path runs against a real Docker daemon in CI.
The remaining gap is network latency and repository size for large public apps, which the 120 s budget
absorbs but this environment cannot measure.
