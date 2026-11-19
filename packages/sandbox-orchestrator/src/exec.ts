import { spawn } from "node:child_process";

import { SandboxError } from "./errors";

const DEFAULT_MAX_OUTPUT_BYTES = 256 * 1024;
const KILL_GRACE_SIGNAL = "SIGKILL";

/**
 * Resource caps applied to every command. On a microVM/container these are backed by kernel limits
 * as well (cgroups, `HostConfig.Memory`, `PidsLimit`); inside the runtime they are applied with
 * `ulimit` before the command runs, which also holds for the development process provider.
 */
export interface CommandLimits {
  readonly memoryMb?: number;
  readonly cpuSeconds?: number;
  readonly pids?: number;
  readonly fileSizeMb?: number;
}

export interface RunCommandOptions {
  readonly command: string;
  readonly cwd: string;
  readonly timeoutMs: number;
  readonly env?: Readonly<Record<string, string>>;
  readonly limits?: CommandLimits;
  readonly maxOutputBytes?: number;
  readonly signal?: AbortSignal;
}

export interface RunResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly durationMs: number;
  readonly timedOut: boolean;
  readonly truncated: boolean;
}

/** Base environment: nothing from the host leaks in unless the caller adds it explicitly. */
export function sandboxEnvironment(
  extra: Readonly<Record<string, string>> = {},
): Record<string, string> {
  return {
    PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
    LANG: "C.UTF-8",
    LC_ALL: "C.UTF-8",
    TERM: "dumb",
    NO_COLOR: "1",
    CI: "1",
    ...extra,
  };
}

/**
 * Prepends the `ulimit` calls that implement `CommandLimits`. `ulimit -f` is expressed in 1024-byte
 * blocks; a failure to lower a limit (already lower on the host) is ignored so the sandbox still
 * starts on stricter hosts.
 */
export function buildCommandScript(command: string, limits: CommandLimits = {}): string {
  const guard = (value: string): string => `${value} 2>/dev/null || true`;
  const prefix: string[] = [];

  if (limits.memoryMb !== undefined) {
    prefix.push(guard(`ulimit -v ${String(Math.floor(limits.memoryMb * 1024))}`));
  }
  if (limits.cpuSeconds !== undefined) {
    prefix.push(guard(`ulimit -t ${String(Math.floor(limits.cpuSeconds))}`));
  }
  if (limits.pids !== undefined) {
    prefix.push(guard(`ulimit -u ${String(Math.floor(limits.pids))}`));
  }
  if (limits.fileSizeMb !== undefined) {
    prefix.push(guard(`ulimit -f ${String(Math.floor(limits.fileSizeMb * 1024))}`));
  }

  return prefix.length === 0 ? command : `${prefix.join("; ")}; ${command}`;
}

/** Runs a shell command with a timeout, process-group kill and bounded output capture. */
export async function runCommand(options: RunCommandOptions): Promise<RunResult> {
  if (options.timeoutMs <= 0 || !Number.isFinite(options.timeoutMs)) {
    throw new SandboxError("invalid_input", "A positive command timeout is required.");
  }
  if (options.signal?.aborted === true) {
    throw new SandboxError("internal", "Command was cancelled before it started.");
  }

  const maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  const script = buildCommandScript(options.command, options.limits ?? {});
  const started = Date.now();

  return await new Promise<RunResult>((resolve, reject) => {
    const child = spawn("/bin/bash", ["-lc", script], {
      cwd: options.cwd,
      env: sandboxEnvironment(options.env),
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });

    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let truncated = false;
    let timedOut = false;
    let settled = false;

    const killGroup = (): void => {
      if (child.pid === undefined) return;
      try {
        process.kill(-child.pid, KILL_GRACE_SIGNAL);
      } catch {
        child.kill(KILL_GRACE_SIGNAL);
      }
    };

    const collect = (chunks: Buffer[], chunk: Buffer, current: number): number => {
      const remaining = maxOutputBytes - current;
      if (remaining <= 0) {
        truncated = true;
        return current;
      }
      if (chunk.length > remaining) {
        chunks.push(chunk.subarray(0, remaining));
        truncated = true;
        return maxOutputBytes;
      }
      chunks.push(chunk);
      return current + chunk.length;
    };

    child.stdout.on("data", (chunk: Buffer) => {
      stdoutBytes = collect(stdout, chunk, stdoutBytes);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderrBytes = collect(stderr, chunk, stderrBytes);
    });

    const timer = setTimeout(() => {
      timedOut = true;
      killGroup();
    }, options.timeoutMs);

    const onAbort = (): void => {
      killGroup();
    };
    options.signal?.addEventListener("abort", onAbort, { once: true });

    const finish = (result: RunResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      resolve(result);
    };

    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      reject(new SandboxError("internal", "Failed to start the sandbox shell.", { cause: error }));
    });

    child.on("close", (exitCode, signal) => {
      finish({
        exitCode: exitCode ?? (signal === null ? 1 : 128),
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
        durationMs: Date.now() - started,
        timedOut,
        truncated,
      });
    });
  });
}
