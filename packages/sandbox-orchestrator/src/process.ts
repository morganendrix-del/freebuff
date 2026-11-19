import { mkdir, rm } from "node:fs/promises";
import path from "node:path";

import { createId } from "@freebuff/shared";
import type { ResourceLimits, SandboxSpec } from "@freebuff/shared";

import { egressEnvironment } from "./egress";
import { SandboxError } from "./errors";
import { runCommand } from "./exec";
import { PreviewSupervisor } from "./preview";
import type { PreviewState } from "./preview";
import type { ExecOptions, SandboxInstance, SandboxProvider } from "./provider";
import { WorkspaceJail } from "./workspace";

export interface ProcessProviderOptions {
  /** Base directory that holds one workspace per sandbox. */
  readonly root: string;
  /** Proxied outbound traffic for cooperative clients (git, npm); see `infra/sandbox-proxy`. */
  readonly egressProxyUrl?: string;
}

function commandLimits(resources: ResourceLimits): {
  memoryMb: number;
  cpuSeconds: number;
  pids: number;
  fileSizeMb: number;
} {
  return {
    memoryMb: resources.memoryMb,
    // The TTL is the hard wall; the CPU cap leaves room for installs inside that wall.
    cpuSeconds: Math.max(30, Math.min(resources.ttlSeconds, 900)),
    pids: resources.pidsLimit,
    fileSizeMb: Math.max(64, Math.min(resources.diskMb, 4_096)),
  };
}

const DEFAULT_COMMAND_TIMEOUT_MS = 120_000;

/**
 * Development provider: runs the same runtime enforcement as production (workspace jail, ulimits,
 * timeouts, output caps, egress env) but as an ordinary child process.
 *
 * It provides **no kernel boundary** — a process cannot be a security boundary for code it runs as
 * the same user. It exists so the orchestration, preview detection and cloud API can be exercised
 * locally and in tests without a Docker daemon; production traffic uses `DockerProvider` or
 * `FirecrackerProvider`, and `isolation` reports `process` so nothing claims otherwise.
 */
export class ProcessProvider implements SandboxProvider {
  readonly name = "process";
  readonly isolation = "process" as const;
  readonly #root: string;
  readonly #proxyUrl: string | undefined;

  constructor(options: ProcessProviderOptions) {
    this.#root = path.resolve(options.root);
    this.#proxyUrl = options.egressProxyUrl;
  }

  async create(options: { readonly spec: SandboxSpec }): Promise<SandboxInstance> {
    const id = createId("sandbox");
    const base = path.join(this.#root, id);
    const workspace = path.join(base, "workspace");
    const home = path.join(base, "home");
    await mkdir(workspace, { recursive: true });
    await mkdir(home, { recursive: true });

    const jail = new WorkspaceJail(workspace);
    await jail.init();

    const limits = commandLimits(options.spec.resources);
    const preview = new PreviewSupervisor();
    const egressEnv = egressEnvironment(options.spec.egress, this.#proxyUrl);
    const baseEnv: Record<string, string> = {
      ...(options.spec.env ?? {}),
      ...egressEnv,
      HOME: home,
      TMPDIR: path.join(base, "tmp"),
    };
    await mkdir(path.join(base, "tmp"), { recursive: true });

    const resolveCwd = (cwd: string | undefined): string =>
      cwd === undefined ? jail.root : jail.resolve(cwd);

    const instance: SandboxInstance = {
      id,
      isolation: this.isolation,
      spec: options.spec,

      async exec(execOptions: ExecOptions) {
        return await runCommand({
          command: execOptions.command,
          cwd: resolveCwd(execOptions.cwd),
          timeoutMs: execOptions.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS,
          limits,
          env: { ...baseEnv, ...(execOptions.env ?? {}) },
        });
      },

      async readFile(relativePath) {
        return await jail.read(relativePath);
      },

      async writeFile(relativePath, content) {
        await jail.write(relativePath, content);
      },

      async listFiles(limit) {
        return await jail.list(limit);
      },

      async exists(relativePath) {
        return await jail.exists(relativePath);
      },

      async startPreview(previewOptions) {
        return await preview.start({
          ...previewOptions,
          cwd: resolveCwd(previewOptions.cwd),
          limits,
          env: { ...baseEnv, ...(previewOptions.env ?? {}) },
        });
      },

      preview(): PreviewState {
        return preview.state();
      },

      async stopPreview() {
        await preview.stop();
      },

      async proxyPreview(request: Request): Promise<Response> {
        const port = preview.port;
        if (port === undefined) {
          throw new SandboxError("not_found", "No preview server is listening in this sandbox.");
        }
        const incoming = new URL(request.url);
        const target = `http://127.0.0.1:${String(port)}${incoming.pathname}${incoming.search}`;
        const headers = new Headers(request.headers);
        headers.delete("host");
        headers.delete("connection");
        return await fetch(target, {
          method: request.method,
          headers,
          redirect: "manual",
          ...(request.method === "GET" || request.method === "HEAD"
            ? {}
            : { body: await request.arrayBuffer() }),
        });
      },

      async stop() {
        await preview.stop();
        await rm(base, { recursive: true, force: true });
      },
    };

    return instance;
  }
}
