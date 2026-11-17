import type { Id } from "./ids";
import type { IsoTimestamp } from "./time";

export type SandboxStatus =
  "cloning" | "failed" | "installing" | "provisioning" | "ready" | "starting" | "stopped";

export interface ResourceLimits {
  readonly cpuCores: number;
  readonly memoryMb: number;
  readonly diskMb: number;
  readonly pidsLimit: number;
  readonly ttlSeconds: number;
}

export interface EgressRule {
  readonly host: string;
  readonly ports: readonly number[];
}

/**
 * Network policy. `deny_all` is the default: sandboxes reach nothing unless a phase explicitly
 * grants hosts (package registries during install, for example).
 */
export interface EgressPolicy {
  readonly mode: "allowlist" | "deny_all" | "open";
  readonly allow: readonly EgressRule[];
}

export interface RepoSource {
  readonly provider: "github";
  readonly owner: string;
  readonly name: string;
  readonly branch?: string;
  readonly installationId?: string;
}

export interface SandboxSpec {
  readonly image: string;
  readonly repo?: RepoSource;
  readonly resources: ResourceLimits;
  readonly egress: EgressPolicy;
  /** Always true: the container/microVM root filesystem is immutable. */
  readonly readOnlyRootFilesystem: true;
  readonly env?: Readonly<Record<string, string>>;
}

export interface SandboxFailure {
  readonly stage: SandboxStatus;
  readonly code: string;
  readonly message: string;
}

export interface SandboxHandle {
  readonly id: Id<"sandbox">;
  readonly status: SandboxStatus;
  readonly createdAt: IsoTimestamp;
  readonly previewUrl?: string;
  readonly failure?: SandboxFailure;
}

export interface StackDetection {
  readonly stack: "bun" | "go" | "node" | "python" | "rust" | "unknown";
  readonly packageManager?: "bun" | "cargo" | "go" | "npm" | "pip" | "pnpm" | "poetry" | "yarn";
  readonly installCommand?: string;
  readonly devCommand?: string;
  readonly previewPort?: number;
}
