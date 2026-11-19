import { createId, createNullLogger, isId } from "@freebuff/shared";
import type {
  EgressPolicy,
  Id,
  IsoTimestamp,
  Logger,
  RepoSource,
  ResourceLimits,
  SandboxFailure,
  SandboxSpec,
  SandboxStatus,
  StackDetection,
} from "@freebuff/shared";

import { PACKAGE_REGISTRY_EGRESS } from "./egress";
import { SandboxError, messageOf } from "./errors";
import { cloneRepository, cloneUrlFor } from "./import";
import type { SandboxInstance, SandboxIsolation, SandboxProvider } from "./provider";
import { detectStack } from "./stack";

export const DEFAULT_SANDBOX_IMAGE = "freebuff/sandbox:local";

export const DEFAULT_RESOURCES: ResourceLimits = {
  cpuCores: 2,
  memoryMb: 2_048,
  diskMb: 4_096,
  pidsLimit: 256,
  ttlSeconds: 3_600,
};

export interface SandboxSpecInput {
  readonly repo: RepoSource;
  readonly image?: string;
  readonly resources?: Partial<ResourceLimits>;
  readonly egress?: EgressPolicy;
  readonly env?: Readonly<Record<string, string>>;
}

/** Complete spec: read-only root filesystem and an explicit egress policy are never optional. */
export function buildSandboxSpec(input: SandboxSpecInput): SandboxSpec {
  return {
    image: input.image ?? DEFAULT_SANDBOX_IMAGE,
    repo: input.repo,
    resources: { ...DEFAULT_RESOURCES, ...input.resources },
    egress: input.egress ?? PACKAGE_REGISTRY_EGRESS,
    readOnlyRootFilesystem: true,
    ...(input.env === undefined ? {} : { env: input.env }),
  };
}

export interface SandboxStage {
  readonly stage: SandboxStatus;
  readonly at: IsoTimestamp;
  readonly durationMs: number;
}

export type SandboxEvent =
  | {
      readonly type: "status";
      readonly at: IsoTimestamp;
      readonly status: SandboxStatus;
      readonly message: string;
    }
  | { readonly type: "log"; readonly at: IsoTimestamp; readonly line: string };

export interface SandboxRecord {
  readonly id: Id<"sandbox">;
  readonly status: SandboxStatus;
  readonly repo: RepoSource;
  readonly isolation: SandboxIsolation;
  readonly createdAt: IsoTimestamp;
  readonly updatedAt: IsoTimestamp;
  readonly expiresAt: IsoTimestamp;
  readonly stages: readonly SandboxStage[];
  readonly logs: readonly string[];
  /** Public preview URL (through the cloud proxy when one is configured). */
  readonly previewUrl?: string;
  readonly previewPort?: number;
  readonly stack?: StackDetection;
  readonly failure?: SandboxFailure;
}

export interface CreateSandboxInput {
  readonly repo: RepoSource;
  /** Overrides the GitHub URL: mirrors, GitHub Enterprise and tests. */
  readonly cloneUrl?: string;
  readonly branch?: string;
  /** Installation token for private repositories. */
  readonly token?: string;
  readonly resources?: Partial<ResourceLimits>;
  readonly egress?: EgressPolicy;
  readonly previewCommand?: string;
}

export interface CreateSandboxHooks {
  /** Called as soon as the sandbox exists, before cloning starts, so callers can return an id. */
  readonly onCreated?: (record: SandboxRecord) => void;
}

export interface SandboxManagerOptions {
  readonly provider: SandboxProvider;
  readonly logger?: Logger;
  readonly now?: () => number;
  readonly image?: string;
  /** Whole pipeline budget; the product gate is 120 s. */
  readonly provisionTimeoutMs?: number;
  readonly installTimeoutMs?: number;
  readonly previewTimeoutMs?: number;
  /** Builds the URL a browser uses for a ready sandbox (cloud preview proxy). */
  readonly previewUrlFor?: (sandboxId: string, port: number) => string;
}

const FAILURE_CODES: Partial<Record<SandboxStatus, string>> = {
  provisioning: "provision_failed",
  cloning: "clone_failed",
  installing: "install_failed",
  starting: "preview_failed",
};

function tail(text: string, lines = 3): string {
  return text.trim().split(/\r?\n/).slice(-lines).join(" ");
}

/**
 * Owns the repository → preview pipeline: provision, clone, detect, install, launch, announce.
 *
 * Every transition is recorded with its duration and every failure names the stage it happened in,
 * so the dashboard and the gate can show where time went rather than a generic error.
 */
export class SandboxManager {
  readonly #provider: SandboxProvider;
  readonly #logger: Logger;
  readonly #now: () => number;
  readonly #image: string;
  readonly #provisionTimeoutMs: number;
  readonly #installTimeoutMs: number;
  readonly #previewTimeoutMs: number;
  readonly #previewUrlFor: ((sandboxId: string, port: number) => string) | undefined;

  readonly #records = new Map<string, SandboxRecord>();
  readonly #instances = new Map<string, SandboxInstance>();
  readonly #events = new Map<string, SandboxEvent[]>();
  readonly #listeners = new Map<string, Set<(event: SandboxEvent) => void>>();

  constructor(options: SandboxManagerOptions) {
    this.#provider = options.provider;
    this.#logger = options.logger ?? createNullLogger();
    this.#now = options.now ?? (() => Date.now());
    this.#image = options.image ?? DEFAULT_SANDBOX_IMAGE;
    this.#provisionTimeoutMs = options.provisionTimeoutMs ?? 120_000;
    this.#installTimeoutMs = options.installTimeoutMs ?? 240_000;
    this.#previewTimeoutMs = options.previewTimeoutMs ?? 60_000;
    this.#previewUrlFor = options.previewUrlFor;
  }

  get provider(): SandboxProvider {
    return this.#provider;
  }

  list(): readonly SandboxRecord[] {
    return [...this.#records.values()].sort((left, right) =>
      right.createdAt.localeCompare(left.createdAt),
    );
  }

  get(id: string): SandboxRecord | undefined {
    return this.#records.get(id);
  }

  events(id: string): readonly SandboxEvent[] {
    return [...(this.#events.get(id) ?? [])];
  }

  subscribe(id: string, listener: (event: SandboxEvent) => void): () => void {
    const listeners = this.#listeners.get(id) ?? new Set<(event: SandboxEvent) => void>();
    listeners.add(listener);
    this.#listeners.set(id, listeners);
    return () => {
      listeners.delete(listener);
    };
  }

  instance(id: string): SandboxInstance | undefined {
    return this.#instances.get(id);
  }

  async create(input: CreateSandboxInput, hooks: CreateSandboxHooks = {}): Promise<SandboxRecord> {
    const spec = buildSandboxSpec({
      repo: input.repo,
      image: this.#image,
      ...(input.resources === undefined ? {} : { resources: input.resources }),
      ...(input.egress === undefined ? {} : { egress: input.egress }),
    });

    const instance = await this.#provider.create({ spec });
    if (!isId("sandbox", instance.id)) {
      await instance.stop();
      throw new SandboxError("internal", "Sandbox provider returned an invalid id.");
    }

    const id = instance.id;
    const startedAt = this.#now();
    const createdAt = new Date(startedAt).toISOString();
    const deadline = startedAt + this.#provisionTimeoutMs;

    let record: SandboxRecord = {
      id,
      status: "provisioning",
      repo: input.repo,
      isolation: instance.isolation,
      createdAt,
      updatedAt: createdAt,
      expiresAt: new Date(startedAt + spec.resources.ttlSeconds * 1_000).toISOString(),
      stages: [],
      logs: [],
    };

    this.#records.set(id, record);
    this.#instances.set(id, instance);
    this.#emit(id, {
      type: "status",
      at: createdAt,
      status: "provisioning",
      message: `Provisioning ${instance.isolation} sandbox`,
    });
    hooks.onCreated?.(record);

    const update = (next: SandboxRecord): void => {
      record = next;
      this.#records.set(id, next);
    };

    const stageStartedAt = new Map<SandboxStatus, number>();
    const enter = (status: SandboxStatus, message: string): void => {
      const at = new Date(this.#now()).toISOString();
      stageStartedAt.set(status, this.#now());
      update({
        ...record,
        status,
        updatedAt: at,
      });
      this.#emit(id, { type: "status", at, status, message });
    };

    const finishStage = (stage: SandboxStatus): void => {
      const started = stageStartedAt.get(stage);
      if (started === undefined) return;
      update({
        ...record,
        stages: [
          ...record.stages,
          { stage, at: new Date(this.#now()).toISOString(), durationMs: this.#now() - started },
        ],
      });
    };

    const remaining = (): number => deadline - this.#now();

    try {
      enter("cloning", "Cloning repository");

      const cloneUrl = input.cloneUrl ?? cloneUrlFor(input.repo);
      await cloneRepository(instance, {
        url: cloneUrl,
        ...(input.branch === undefined ? {} : { branch: input.branch }),
        ...(input.token === undefined ? {} : { token: input.token }),
        timeoutMs: Math.max(1_000, Math.min(120_000, remaining())),
      });
      finishStage("cloning");
      this.#appendLog(id, "clone complete");

      const stack = await detectStack({
        exists: (candidate) => instance.exists(candidate),
        read: (candidate) => instance.readFile(candidate),
      });
      update({ ...record, stack });
      this.#appendLog(id, `detected stack: ${stack.stack}`);

      if (stack.installCommand !== undefined) {
        enter("installing", `Installing dependencies (${stack.installCommand})`);
        const install = await instance.exec({
          command: stack.installCommand,
          timeoutMs: Math.max(1_000, Math.min(this.#installTimeoutMs, remaining())),
        });
        this.#appendLog(id, `install exit ${String(install.exitCode)}`);
        if (install.exitCode !== 0) {
          throw new SandboxError(
            "internal",
            `Dependency installation failed (exit ${String(install.exitCode)}): ${tail(install.stderr)}`,
          );
        }
        finishStage("installing");
      }

      const devCommand = input.previewCommand ?? stack.devCommand;
      if (devCommand === undefined) {
        throw new SandboxError(
          "invalid_input",
          `No dev command found for this ${stack.stack} repository; add a dev script or pass one explicitly.`,
        );
      }

      enter("starting", `Starting preview (${devCommand})`);
      const preview = await instance.startPreview({
        command: devCommand,
        timeoutMs: Math.max(1_000, Math.min(this.#previewTimeoutMs, remaining())),
        ...(stack.previewPort === undefined ? {} : { expectedPort: stack.previewPort }),
      });

      if (preview.phase !== "listening" || preview.port === undefined) {
        throw new SandboxError(
          "timeout",
          preview.failure ?? "The preview server did not answer before the deadline.",
        );
      }

      finishStage("starting");
      const at = new Date(this.#now()).toISOString();
      const previewUrl =
        this.#previewUrlFor === undefined
          ? `http://127.0.0.1:${String(preview.port)}/`
          : this.#previewUrlFor(id, preview.port);

      update({
        ...record,
        status: "ready",
        updatedAt: at,
        previewUrl,
        previewPort: preview.port,
      });
      this.#emit(id, {
        type: "status",
        at,
        status: "ready",
        message: `Preview ready at ${previewUrl} (${String(this.#now() - startedAt)} ms)`,
      });
      this.#logger.info("sandbox ready", {
        sandboxId: id,
        isolation: instance.isolation,
        durationMs: this.#now() - startedAt,
        stack: stack.stack,
      });

      return record;
    } catch (error) {
      const failedStage = record.status;
      const failure: SandboxFailure = {
        stage: failedStage,
        code: FAILURE_CODES[failedStage] ?? "internal",
        message: messageOf(error),
      };
      const at = new Date(this.#now()).toISOString();

      update({ ...record, status: "failed", failure, updatedAt: at });
      this.#emit(id, {
        type: "status",
        at,
        status: "failed",
        message: `${failure.code}: ${failure.message}`,
      });
      this.#logger.warn("sandbox failed", {
        sandboxId: id,
        stage: failure.stage,
        code: failure.code,
      });

      await instance.stop().catch(() => undefined);
      this.#instances.delete(id);
      return record;
    }
  }

  async stop(id: string): Promise<SandboxRecord | undefined> {
    const record = this.#records.get(id);
    if (record === undefined) return undefined;

    const instance = this.#instances.get(id);
    if (instance !== undefined) {
      await instance.stop().catch((error: unknown) => {
        this.#logger.warn("sandbox stop failed", { sandboxId: id, error: messageOf(error) });
      });
      this.#instances.delete(id);
    }

    const at = new Date(this.#now()).toISOString();
    const stopped: SandboxRecord = { ...record, status: "stopped", updatedAt: at };
    this.#records.set(id, stopped);
    this.#emit(id, { type: "status", at, status: "stopped", message: "Sandbox stopped" });
    return stopped;
  }

  /** Stops sandboxes whose TTL elapsed. Intended to be called by the cloud scheduler. */
  async reapExpired(): Promise<readonly string[]> {
    const now = this.#now();
    const expired = [...this.#records.values()]
      .filter(
        (record) =>
          (record.status === "ready" || record.status === "starting") &&
          Date.parse(record.expiresAt) <= now,
      )
      .map((record) => record.id);

    for (const id of expired) {
      await this.stop(id);
    }
    return expired;
  }

  createRecordId(): Id<"sandbox"> {
    return createId("sandbox");
  }

  #appendLog(id: string, line: string): void {
    const record = this.#records.get(id);
    if (record === undefined) return;
    const at = new Date(this.#now()).toISOString();
    this.#records.set(id, { ...record, logs: [...record.logs, line], updatedAt: at });
    this.#emit(id, { type: "log", at, line });
  }

  #emit(id: string, event: SandboxEvent): void {
    const events = this.#events.get(id) ?? [];
    events.push(event);
    this.#events.set(id, events);
    for (const listener of this.#listeners.get(id) ?? []) {
      listener(event);
    }
  }
}
