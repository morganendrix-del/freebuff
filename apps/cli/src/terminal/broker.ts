import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";

import { PlatformError, TimeoutError } from "@freebuff/shared";

/** Anything a broker command prints beyond this is dropped rather than buffered forever. */
export const MAX_CAPTURE_CHARS = 200_000;

export interface BrokerExecResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly durationMs: number;
  readonly truncated: boolean;
}

export interface BrokerSession {
  readonly id: string;
  readonly cwd: string;
}

export interface BrokerExecOptions {
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
  readonly cwd?: string;
}

export interface TerminalBroker {
  open(options: { readonly cwd: string }): BrokerSession;
  exec(sessionId: string, command: string, options?: BrokerExecOptions): Promise<BrokerExecResult>;
  close(sessionId: string): void;
  closeAll(): void;
}

export type SpawnImpl = (
  command: string,
  args: readonly string[],
  options: {
    readonly cwd: string;
    readonly stdio: readonly ["ignore", "pipe", "pipe"];
    readonly detached: boolean;
    readonly env: Readonly<Record<string, string | undefined>>;
  },
) => ChildProcess;

export interface TerminalBrokerOptions {
  readonly spawnImpl?: SpawnImpl;
  readonly defaultTimeoutMs?: number;
  readonly env?: Readonly<Record<string, string | undefined>>;
}

const DEFAULT_TIMEOUT_MS = 120_000;
const SECRET_ENV_PATTERN = /(token|secret|password|api[_-]?key|credential)/i;

/**
 * Shell output must never reach the agent's own stdio, so the broker always spawns with piped
 * stdout/stderr (never `inherit`) and its own process group. Credentials are stripped from the child
 * environment. Phase 3 swaps this backend for the sandbox; callers see only this interface.
 */
export function createLocalTerminalBroker(options: TerminalBrokerOptions = {}): TerminalBroker {
  const spawnImpl: SpawnImpl = options.spawnImpl ?? defaultSpawn;
  const defaultTimeoutMs = options.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS;
  const childEnv = sanitizeEnv(options.env ?? process.env);
  const sessions = new Map<string, BrokerSession>();

  return {
    open({ cwd }) {
      const session: BrokerSession = { id: `terminal_${crypto.randomUUID()}`, cwd };
      sessions.set(session.id, session);
      return session;
    },

    async exec(sessionId, command, execOptions = {}) {
      const session = sessions.get(sessionId);
      if (session === undefined) {
        throw new PlatformError("not_found", `Unknown terminal session: ${sessionId}`);
      }
      if (command.trim() === "") {
        throw new PlatformError("invalid_input", "A command is required.");
      }

      return runCommand({
        command,
        cwd: execOptions.cwd ?? session.cwd,
        timeoutMs: execOptions.timeoutMs ?? defaultTimeoutMs,
        spawnImpl,
        env: childEnv,
        ...(execOptions.signal === undefined ? {} : { signal: execOptions.signal }),
      });
    },

    close(sessionId) {
      sessions.delete(sessionId);
    },

    closeAll() {
      sessions.clear();
    },
  };
}

interface RunCommandOptions {
  readonly command: string;
  readonly cwd: string;
  readonly timeoutMs: number;
  readonly spawnImpl: SpawnImpl;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly signal?: AbortSignal;
}

function runCommand(options: RunCommandOptions): Promise<BrokerExecResult> {
  const startedAt = performance.now();
  const child = options.spawnImpl("bash", ["-lc", options.command], {
    cwd: options.cwd,
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
    env: options.env,
  });

  return new Promise<BrokerExecResult>((resolve, reject) => {
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let captured = 0;
    let truncated = false;
    let settled = false;

    const finish = (): void => {
      options.signal?.removeEventListener("abort", onAbort);
      clearTimeout(timer);
    };

    const killTree = (): void => {
      if (child.pid === undefined) return;
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    };

    const capture = (chunks: Buffer[], chunk: Buffer | string): void => {
      if (captured >= MAX_CAPTURE_CHARS) {
        truncated = true;
        return;
      }
      const buffer = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
      const room = MAX_CAPTURE_CHARS - captured;
      const slice = buffer.byteLength > room ? buffer.subarray(0, room) : buffer;
      if (slice.byteLength < buffer.byteLength) truncated = true;
      captured += slice.byteLength;
      chunks.push(slice);
    };

    const onAbort = (): void => {
      if (settled) return;
      settled = true;
      killTree();
      finish();
      reject(new PlatformError("cancelled", "Terminal command cancelled."));
    };

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      killTree();
      finish();
      reject(
        new TimeoutError(
          `Terminal command timed out after ${String(options.timeoutMs)} ms.`,
          options.timeoutMs,
        ),
      );
    }, options.timeoutMs);

    if (options.signal !== undefined) {
      if (options.signal.aborted) {
        onAbort();
        return;
      }
      options.signal.addEventListener("abort", onAbort, { once: true });
    }

    child.stdout?.on("data", (chunk: Buffer) => {
      capture(stdoutChunks, chunk);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      capture(stderrChunks, chunk);
    });

    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      finish();
      reject(
        new PlatformError("execution_failed", `Cannot start the shell: ${error.message}`, {
          cause: error,
        }),
      );
    });

    child.once("close", (code) => {
      if (settled) return;
      settled = true;
      finish();
      resolve({
        exitCode: code ?? 1,
        stdout: Buffer.concat(stdoutChunks).toString("utf8"),
        stderr: Buffer.concat(stderrChunks).toString("utf8"),
        durationMs: Math.round(performance.now() - startedAt),
        truncated,
      });
    });
  });
}

const defaultSpawn: SpawnImpl = (command, args, options) =>
  spawn(command, [...args], {
    cwd: options.cwd,
    detached: options.detached,
    env: options.env,
    stdio: ["ignore", "pipe", "pipe"],
  });

/** Drops credential-looking variables so a shell command cannot read the platform token. */
export function sanitizeEnv(
  env: Readonly<Record<string, string | undefined>>,
): Record<string, string | undefined> {
  const clean: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(env)) {
    if (SECRET_ENV_PATTERN.test(key)) continue;
    clean[key] = value;
  }
  return clean;
}
