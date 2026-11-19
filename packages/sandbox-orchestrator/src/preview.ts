import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";

import { detectPreviewPort, normalizePreviewUrl, stripAnsi } from "./detect-preview";
import { SandboxError } from "./errors";
import { buildCommandScript, sandboxEnvironment } from "./exec";
import type { CommandLimits } from "./exec";

const MAX_LOG_LINES = 400;
const POLL_INTERVAL_MS = 100;
const DEFAULT_PREVIEW_TIMEOUT_MS = 60_000;
const PROBE_TIMEOUT_MS = 2_000;

export type PreviewPhase = "failed" | "idle" | "listening" | "starting";

export interface PreviewState {
  readonly phase: PreviewPhase;
  readonly port?: number;
  readonly url?: string;
  readonly failure?: string;
  readonly logs: readonly string[];
}

export interface PreviewStartOptions {
  readonly command: string;
  readonly cwd: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly limits?: CommandLimits;
  /** Framework default, used until the server announces its own port. */
  readonly expectedPort?: number;
  readonly timeoutMs?: number;
  readonly probePath?: string;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Supervises a long-running dev server inside the sandbox.
 *
 * The port is taken from the server's own output rather than assumed, then verified with a real HTTP
 * probe before the sandbox is called ready — a process that prints a URL it never serves does not
 * produce a working preview.
 */
export class PreviewSupervisor {
  #child: ChildProcess | undefined;
  #command: string | undefined;
  #logs: string[] = [];
  #phase: PreviewPhase = "idle";
  #port: number | undefined;
  #failure: string | undefined;

  get port(): number | undefined {
    return this.#port;
  }

  state(): PreviewState {
    return {
      phase: this.#phase,
      logs: [...this.#logs],
      ...(this.#port === undefined ? {} : { port: this.#port }),
      ...(this.#port === undefined ? {} : { url: `http://127.0.0.1:${String(this.#port)}/` }),
      ...(this.#failure === undefined ? {} : { failure: this.#failure }),
    };
  }

  async start(options: PreviewStartOptions): Promise<PreviewState> {
    await this.stop();
    this.#phase = "starting";
    this.#logs = [];
    this.#port = undefined;
    this.#failure = undefined;
    this.#command = options.command;

    const child = spawn(
      "/bin/bash",
      ["-lc", buildCommandScript(options.command, options.limits ?? {})],
      {
        cwd: options.cwd,
        env: sandboxEnvironment(options.env),
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    this.#child = child;

    const append = (chunk: Buffer): void => {
      for (const line of stripAnsi(chunk.toString("utf8")).split(/\r?\n/)) {
        if (line.trim() === "") continue;
        this.#logs.push(line);
        if (this.#logs.length > MAX_LOG_LINES) this.#logs.shift();
      }
    };

    child.stdout.on("data", append);
    child.stderr.on("data", append);

    const exitInfo = { message: "" };
    child.on("exit", (code, signal) => {
      exitInfo.message = signal === null ? `code ${String(code)}` : `signal ${signal}`;
    });
    child.on("error", (error) => {
      this.#failure = `Preview process failed to start: ${error.message}`;
    });

    const deadline = Date.now() + (options.timeoutMs ?? DEFAULT_PREVIEW_TIMEOUT_MS);
    const expectedPort = options.expectedPort;

    while (Date.now() < deadline) {
      if (this.#hasFailure()) break;

      const announced = detectPreviewPort(this.#logs.join("\n"));
      const candidate = expectedPort ?? announced ?? this.#port;

      if (candidate !== undefined && (await this.#probe(candidate, options.probePath ?? "/"))) {
        this.#port = candidate;
        this.#phase = "listening";
        return this.state();
      }

      if (exitInfo.message !== "" && announced === undefined && expectedPort === undefined) {
        this.#phase = "failed";
        this.#failure = `Preview process exited before announcing a port (${exitInfo.message}).`;
        break;
      }

      await delay(POLL_INTERVAL_MS);
    }

    this.#phase = "failed";
    if (this.#failure === undefined) {
      this.#failure = `No preview server answered within ${String(options.timeoutMs ?? DEFAULT_PREVIEW_TIMEOUT_MS)} ms.`;
    }
    await this.stop();
    return this.state();
  }

  async stop(): Promise<void> {
    const child = this.#child;
    this.#child = undefined;
    if (child === undefined) return;

    if (child.pid !== undefined) {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    }

    if (child.exitCode === null && child.signalCode === null) {
      await Promise.race([
        new Promise<void>((resolve) => {
          child.once("exit", () => {
            resolve();
          });
        }),
        delay(2_000),
      ]);
    }

    if (this.#phase !== "failed") this.#phase = "idle";
  }

  /** Indirection keeps control-flow analysis from assuming the field stays undefined. */
  #hasFailure(): boolean {
    return this.#failure !== undefined;
  }

  async #probe(port: number, probePath: string): Promise<boolean> {
    if (!Number.isInteger(port) || port <= 0) return false;
    try {
      const response = await fetch(`http://127.0.0.1:${String(port)}${probePath}`, {
        signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
        headers: { "user-agent": "freebuff-sandbox-probe" },
      });
      await response.body?.cancel();
      return response.status < 500;
    } catch {
      return false;
    }
  }

  /** Log text announced so far, used by callers that report progress. */
  logs(): readonly string[] {
    return [...this.#logs];
  }

  /** The exact command being supervised, for diagnostics. */
  command(): string | undefined {
    return this.#command;
  }
}

/** Resolves the loopback URL of a listening preview port. */
export function previewUrlFor(port: number): string {
  return normalizePreviewUrl(`http://127.0.0.1:${String(port)}/`);
}

export function assertPreviewPort(port: number): number {
  if (!Number.isInteger(port) || port <= 0 || port > 65_535) {
    throw new SandboxError("invalid_input", "Preview port must be an integer between 1 and 65535.");
  }
  return port;
}
