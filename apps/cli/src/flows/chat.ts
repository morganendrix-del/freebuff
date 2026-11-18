import {
  PathLockManager,
  createFileSystemWorkspace,
  createToolRegistry,
  startAgentRun,
} from "@freebuff/agent-runtime";
import type { LlmProvider } from "@freebuff/llm-providers";
import type {
  AgentEvent,
  AgentLoopLimits,
  AgentPermissions,
  AgentRunResult,
  Id,
  ModelSpec,
  QuotaDecision,
  Session,
  Surface,
} from "@freebuff/shared";
import {
  AGENT_LOOP_DEFAULTS,
  DEFAULT_AGENT_PERMISSIONS,
  resolveModelForTier,
} from "@freebuff/shared";
import type { PlatformClient } from "@freebuff/sdk";

import { createBrokerCommandExecutor } from "../terminal/executor";
import { QuotaDeniedError } from "./errors";
import { resolveProject } from "./projects";

export const DEFAULT_SYSTEM_PROMPT =
  "You are a coding agent working inside the user's repository. Make the smallest correct change, " +
  "use the tools to read before you write, and summarise what you changed when you are done.";

export interface ChatTurnOptions {
  readonly client: PlatformClient;
  readonly projectRoot: string;
  readonly prompt: string;
  readonly provider: LlmProvider;
  readonly sessionId?: Id<"session">;
  readonly title?: string;
  readonly surface?: Surface;
  readonly modelId?: string;
  readonly permissions?: AgentPermissions;
  readonly limits?: Partial<AgentLoopLimits>;
  readonly systemPrompt?: string;
  readonly onEvent?: (event: AgentEvent) => void;
}

export interface ChatTurnResult {
  readonly session: Session;
  readonly projectId: Id<"project">;
  readonly result: AgentRunResult;
  readonly events: readonly AgentEvent[];
  readonly quota: QuotaDecision;
  readonly model: ModelSpec;
}

/**
 * One turn of the CLI chat: quota gate → project resolution → session → agent run (real Phase 1
 * runtime, real files, shell through the terminal broker) → durable history through the SDK.
 * The TUI and the headless command both call this, so the gate exercises the same path users do.
 */
export async function runChatTurn(options: ChatTurnOptions): Promise<ChatTurnResult> {
  const quota = await options.client.quota.authorizeRun();
  if (!quota.allowed) throw new QuotaDeniedError(quota);

  const project = await resolveProject({
    client: options.client,
    rootPath: options.projectRoot,
  });

  const session =
    options.sessionId === undefined
      ? await options.client.sessions.create({
          projectId: project.id,
          surface: options.surface ?? "cli",
          title: options.title ?? options.prompt.slice(0, 60),
        })
      : await options.client.sessions.get(options.sessionId);

  const selection = resolveModelForTier(session.tier, options.modelId);
  if (!selection.ok) throw new Error(selection.error.message);
  const model = selection.value;

  const terminal = await options.client.terminals.create(session.id);
  const events: AgentEvent[] = [];

  try {
    const workspace = createFileSystemWorkspace({
      root: project.rootPath,
      locks: new PathLockManager("serialize"),
      commandExecutor: createBrokerCommandExecutor({
        client: options.client,
        terminalId: terminal.id,
        rootPath: project.rootPath,
      }),
    });

    const handle = startAgentRun(
      {
        sessionId: session.id,
        projectRoot: project.rootPath,
        model,
        provider: options.provider,
        registry: createToolRegistry(workspace),
        systemPrompt: options.systemPrompt ?? DEFAULT_SYSTEM_PROMPT,
        permissions: options.permissions ?? DEFAULT_AGENT_PERMISSIONS,
        limits: { ...AGENT_LOOP_DEFAULTS, ...options.limits },
      },
      options.prompt,
    );

    for await (const event of handle.events) {
      events.push(event);
      options.onEvent?.(event);
    }

    const result = await handle.result;
    const persisted = await options.client.sessions.appendMessages(session.id, result.messages);

    return {
      session: persisted,
      projectId: project.id,
      result,
      events,
      quota,
      model,
    };
  } finally {
    await options.client.terminals.close(terminal.id).catch(() => undefined);
  }
}
