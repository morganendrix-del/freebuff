import type { SandboxSpec } from "@freebuff/shared";

import type { RunResult } from "./exec";
import type { PreviewStartOptions, PreviewState } from "./preview";

export type SandboxIsolation = "container" | "microvm" | "process";

export interface ExecOptions {
  readonly command: string;
  /** Relative to the sandbox workspace root. */
  readonly cwd?: string;
  readonly timeoutMs?: number;
  readonly env?: Readonly<Record<string, string>>;
}

/**
 * One running sandbox.
 *
 * `isolation` states what actually separates the sandbox from the host: `microvm` (Firecracker),
 * `container` (hardened Docker) or `process` (development only, no kernel boundary). The orchestrator
 * and the cloud API expose it so a preview's guarantees are never implied.
 */
export interface SandboxInstance {
  readonly id: string;
  readonly isolation: SandboxIsolation;
  readonly spec: SandboxSpec;
  exec(options: ExecOptions): Promise<RunResult>;
  readFile(path: string): Promise<string>;
  writeFile(path: string, content: string): Promise<void>;
  listFiles(limit?: number): Promise<string[]>;
  exists(path: string): Promise<boolean>;
  startPreview(
    options: Omit<PreviewStartOptions, "cwd"> & { readonly cwd?: string },
  ): Promise<PreviewState>;
  preview(): PreviewState;
  stopPreview(): Promise<void>;
  /** Proxies a browser request to the listening preview server. */
  proxyPreview(request: Request): Promise<Response>;
  stop(): Promise<void>;
}

export interface SandboxProvider {
  readonly name: string;
  readonly isolation: SandboxIsolation;
  create(options: { readonly spec: SandboxSpec }): Promise<SandboxInstance>;
}
