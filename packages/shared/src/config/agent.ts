import type { AgentLoopLimits } from "../types/agent";
import type { AgentPermissions } from "../types/permissions";

/** Default loop bounds. Overridable per run; config-driven so limits never hide in the loop code. */
export const AGENT_LOOP_DEFAULTS: AgentLoopLimits = {
  maxSteps: 32,
  maxToolCallsPerStep: 8,
  maxSubagents: 4,
  subagentConcurrency: 3,
};

/** File reads/edits and shell in the sandbox are on; network egress is off unless granted. */
export const DEFAULT_AGENT_PERMISSIONS: AgentPermissions = {
  allowFileWrites: true,
  allowShellCommands: true,
  allowNetwork: false,
};

/** Upper bound for a single tool call, including sandbox round-trip. */
export const DEFAULT_TOOL_TIMEOUT_MS = 60_000;

/** Largest tool output (in characters) handed back to the model in one step. */
export const MAX_TOOL_OUTPUT_CHARS = 60_000;
