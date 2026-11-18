import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";

import { describe, expect, test } from "vitest";

import { createId, type AgentEvent } from "@freebuff/shared";
import {
  PathLockManager,
  createFileSystemWorkspace,
  createToolRegistry,
  startAgentRun,
  type CommandExecutor,
} from "@freebuff/agent-runtime";

import { ScriptedProvider, completed, script, toolCall } from "./agent/scripted-provider";
import { TEST_MODEL, waitFor, withFixtureRepo } from "./agent/harness";

interface ProcessRecord {
  pid: number | undefined;
  killed: boolean;
}

/** Test-only executor: spawns a real process so cancellation can be proven at the OS level. */
function createSubprocessExecutor(record: ProcessRecord): CommandExecutor {
  return {
    async execute(command, { cwd, signal }) {
      // node:child_process rather than Bun.spawn: vitest workers run on Node even under the Bun CLI.
      const child = spawn("bash", ["-lc", command], {
        cwd,
        stdio: ["ignore", "pipe", "pipe"],
      });
      record.pid = child.pid;

      const onAbort = (): void => {
        record.killed = true;
        child.kill("SIGKILL");
      };

      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });

      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
      child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));

      try {
        const exitCode = await new Promise<number>((resolve, reject) => {
          child.once("error", reject);
          child.once("close", (code) => {
            resolve(code ?? 1);
          });
        });
        return {
          exitCode,
          stdout: Buffer.concat(stdout).toString("utf8"),
          stderr: Buffer.concat(stderr).toString("utf8"),
          durationMs: 0,
        };
      } finally {
        signal.removeEventListener("abort", onAbort);
      }
    },
  };
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function buildRun(
  root: string,
  prompt: string,
  provider: ScriptedProvider,
  executor?: CommandExecutor,
) {
  const workspace = createFileSystemWorkspace({
    root,
    locks: new PathLockManager(),
    ...(executor === undefined ? {} : { commandExecutor: executor }),
  });

  return startAgentRun(
    {
      sessionId: createId("session"),
      projectRoot: root,
      model: TEST_MODEL,
      provider,
      registry: createToolRegistry(workspace),
      systemPrompt: "You are a coding agent.",
    },
    prompt,
  );
}

describe("cancellation (Phase 1 gate)", () => {
  test("aborting during a tool call kills the process and cancels the run", async () => {
    await withFixtureRepo("bugfix", async (root) => {
      const record: ProcessRecord = { pid: undefined, killed: false };
      const prompt = "Run the long-running check";
      const provider = new ScriptedProvider([
        script(prompt, [
          ...toolCall(0, "call_cmd", "run_command", { command: "exec sleep 60" }),
          completed("tool_use"),
        ]),
      ]);

      const handle = buildRun(root, prompt, provider, createSubprocessExecutor(record));
      const events: AgentEvent[] = [];
      const consumer = (async () => {
        for await (const event of handle.events) events.push(event);
      })();

      await waitFor(() => events.some((event) => event.type === "tool_call"));
      await waitFor(() => record.pid !== undefined);

      handle.cancel("test cancellation");
      const result = await handle.result;
      await consumer;

      expect(result.status).toBe("cancelled");
      expect(result.reason).toBe("cancelled");
      expect(record.killed).toBe(true);
      expect(isAlive(record.pid ?? 0)).toBe(false);
      expect(events.some((event) => event.type === "run_cancelled")).toBe(true);
      expect(events.some((event) => event.type === "run_failed")).toBe(false);
    });
  });

  test("aborting mid-stream closes the provider stream with no orphaned connection", async () => {
    await withFixtureRepo("bugfix", async (root) => {
      const prompt = "Explain the repository";
      const provider = new ScriptedProvider([
        script(prompt, [{ type: "assistant_text_delta", text: "Looking at the code" }], 30_000),
      ]);

      const handle = buildRun(root, prompt, provider);
      const events: AgentEvent[] = [];
      const consumer = (async () => {
        for await (const event of handle.events) events.push(event);
      })();

      await waitFor(() => events.some((event) => event.type === "assistant_delta"));
      expect(provider.closedStreams).toBe(0);

      handle.cancel("stop streaming");
      const result = await handle.result;
      await consumer;

      expect(result.status).toBe("cancelled");
      expect(provider.closedStreams).toBe(1);

      // The fixture repo is untouched by a cancelled read-only run.
      expect(await readFile(`${root}/src/add.ts`, "utf8")).toContain("left - right");
    });
  });
});
