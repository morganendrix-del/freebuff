/** What the agent is allowed to do in a session. Enforced by the tool registry and sandbox. */
export interface AgentPermissions {
  readonly allowFileWrites: boolean;
  readonly allowShellCommands: boolean;
  readonly allowNetwork: boolean;
  /** Optional command prefix allowlist; empty/undefined means "any command the sandbox permits". */
  readonly shellCommandAllowlist?: readonly string[];
}
