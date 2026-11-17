# @freebuff/agent-runtime

Status: **not started** — delivered by the Phase 1 gate.

Scope: the composable multi-step agent loop (tool calling, deterministic tool-call parsing,
streaming `AgentEvent`s, cancellation, retries with backoff), the tool registry and the tools
themselves (read/write/edit/multi-edit files, ripgrep search, sandboxed shell, web fetch, code-map
queries), and subagent delegation including parallel subagents.

Gate: five scripted tasks over fixture repos produce exactly the expected file diffs.

Contracts it must satisfy: `packages/shared/src/types/{agent,tool}.ts`, defaults in
`packages/shared/src/config/agent.ts`.
