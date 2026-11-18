# @freebuff/agent-runtime

Status: **implemented** (Phase 1). Gate: five scripted tasks over fixture repos produce exactly the
expected file diffs.

The composable agent loop shared by every surface (CLI, desktop, web builder, cloud sandbox). It owns
the step machine, tool dispatch, cancellation and subagent delegation; it owns no I/O policy — file
access goes through a `WorkspaceHost`, shell access through the `CommandExecutor` port, and model calls
through `LlmProvider`.

## Modules

| Module            | Responsibility                                                                                          |
| ----------------- | ------------------------------------------------------------------------------------------------------- |
| `loop.ts`         | `startAgentRun`: stream one provider turn, parse tool calls, run them, repeat until done                |
| `events.ts`       | `EventQueue` — backpressure-free `AsyncIterable<AgentEvent>` handed to callers                          |
| `parsing.ts`      | `ToolCallAccumulator` + `parseToolCalls`: deterministic argument assembly and validation                |
| `json-schema.ts`  | Validator for the JSON-Schema subset tools declare (type, enum, bounds, required, extra keys)           |
| `registry.ts`     | `ToolRegistry`: the only path from a model tool call to real work                                       |
| `locking.ts`      | `PathLockManager`: per-path `serialize` or `reject` policy for concurrent writers                       |
| `cancellation.ts` | `CancellationScope`: parent/child abort trees plus cleanup hooks                                        |
| `tools/`          | read, write, edit, multi-edit, ripgrep search, `run_command`, `web_fetch`, `code_map_query`, `delegate` |

## Guarantees

- **No unsandboxed shell.** `run_command` requires an attached `CommandExecutor`; without one the tool
  fails with `permission_denied`. There is no fallback to `child_process` in production code
  (`DECISIONS.md` D11).
- **Cancellation reaches in-flight work.** The run scope aborts the tool signal, so a cancelled run
  kills its subprocess and closes the provider stream instead of orphaning them (`withTimeout` threads
  the parent signal into the tool's abort signal).
- **Deterministic parsing.** Malformed JSON, truncated fragments, unknown tools, schema violations and
  unexpected properties all become `ToolOutcome` failures; the same drafts parsed twice produce
  byte-identical results.
- **Concurrency is explicit.** Parallel subagents share the parent's `PathLockManager`, so disjoint
  edits proceed together and overlapping edits are serialised or rejected — never interleaved.
- **Bounded.** Step, tool-call-per-step, subagent and token-budget limits come from
  `AgentLoopLimits`; defaults live in `packages/shared/src/config/agent.ts`.

## Usage

```ts
const handle = startAgentRun(
  { sessionId, projectRoot, model, provider, registry, systemPrompt, limits, permissions },
  prompt,
);
for await (const event of handle.events) render(event);
const result = await handle.result;
```

## Tests

`packages/agent-runtime/test/parsing.test.ts` (12), `tests/integration/agent/tasks.test.ts` (5 fixture
tasks), `tests/integration/cancellation.test.ts` (2), `tests/integration/subagents.test.ts` (3).
