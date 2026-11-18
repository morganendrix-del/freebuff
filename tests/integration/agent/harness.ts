import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  AGENT_LOOP_DEFAULTS,
  createId,
  findModel,
  type AgentEvent,
  type AgentLoopLimits,
  type AgentRunResult,
  type ModelSpec,
} from "@freebuff/shared";
import {
  PathLockManager,
  createFileSystemWorkspace,
  createToolRegistry,
  startAgentRun,
  type CommandExecutor,
} from "@freebuff/agent-runtime";

import { ScriptedProvider, type Script } from "./scripted-provider";

export const TEST_MODEL: ModelSpec =
  findModel("deepseek-flash") ??
  ((): never => {
    throw new Error("fixture model missing from the catalogue");
  })();

export interface HarnessResult {
  readonly events: readonly AgentEvent[];
  readonly result: AgentRunResult;
  readonly provider: ScriptedProvider;
}

export interface HarnessOptions {
  readonly lockPolicy?: "reject" | "serialize";
  readonly limits?: Partial<AgentLoopLimits>;
  readonly commandExecutor?: CommandExecutor;
  readonly onEvent?: (event: AgentEvent) => void;
}

/** Copies a fixture repo to a temp dir, runs the callback, then removes the copy. */
export async function withFixtureRepo(
  name: string,
  run: (root: string) => Promise<void>,
): Promise<void> {
  const source = path.resolve(import.meta.dirname, "../../fixtures/repos", name);
  const root = await mkdtemp(path.join(tmpdir(), `freebuff-${name}-`));
  await cp(source, root, { recursive: true });

  try {
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

export async function runScripted(
  root: string,
  prompt: string,
  scripts: readonly Script[],
  options: HarnessOptions = {},
): Promise<HarnessResult> {
  const workspace = createFileSystemWorkspace({
    root,
    locks: new PathLockManager(options.lockPolicy ?? "serialize"),
    ...(options.commandExecutor === undefined ? {} : { commandExecutor: options.commandExecutor }),
  });
  const registry = createToolRegistry(workspace);
  const provider = new ScriptedProvider([...scripts]);

  const handle = startAgentRun(
    {
      sessionId: createId("session"),
      projectRoot: root,
      model: TEST_MODEL,
      provider,
      registry,
      systemPrompt: "You are a coding agent working in a repository.",
      limits: { ...AGENT_LOOP_DEFAULTS, ...options.limits },
      ...(options.onEvent === undefined ? {} : { onEvent: options.onEvent }),
    },
    prompt,
  );

  const events: AgentEvent[] = [];
  for await (const event of handle.events) events.push(event);

  return { events, result: await handle.result, provider };
}

export async function waitFor(
  predicate: () => boolean,
  timeoutMs = 5_000,
  intervalMs = 10,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for condition");
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}
