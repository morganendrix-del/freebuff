import path from "node:path";

import type { CommandExecutor } from "@freebuff/agent-runtime";
import type { PlatformClient } from "@freebuff/sdk";

export interface BrokerExecutorOptions {
  readonly client: PlatformClient;
  readonly terminalId: string;
  readonly rootPath: string;
}

/**
 * Routes the agent's shell tool through the platform's terminal channel, so agent stdio is never
 * mixed with child-process output. Phase 3 points the same channel inside the sandbox.
 */
export function createBrokerCommandExecutor(options: BrokerExecutorOptions): CommandExecutor {
  return {
    async execute(command, { cwd, timeoutMs, signal }) {
      const relativeCwd = toRelative(options.rootPath, cwd);
      const result = await options.client.terminals.exec(options.terminalId, command, {
        timeoutMs,
        signal,
        ...(relativeCwd === undefined ? {} : { cwd: relativeCwd }),
      });

      return {
        exitCode: result.exitCode,
        stdout: result.stdout,
        stderr: result.stderr,
        durationMs: result.durationMs,
      };
    },
  };
}

/** Only paths inside the project may be sent across the channel; anything else keeps the default cwd. */
function toRelative(rootPath: string, cwd: string): string | undefined {
  const relative = path.relative(path.resolve(rootPath), path.resolve(cwd));
  if (relative === "") return ".";
  if (relative.startsWith("..") || path.isAbsolute(relative)) return undefined;
  return relative;
}
