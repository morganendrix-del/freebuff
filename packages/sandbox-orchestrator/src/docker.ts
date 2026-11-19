import { randomBytes } from "node:crypto";
import { request } from "node:http";

import { createId } from "@freebuff/shared";
import type { SandboxSpec } from "@freebuff/shared";

import { SandboxError } from "./errors";
import type { SandboxInstance, SandboxProvider } from "./provider";
import { SandboxRuntimeClient, createRemoteSandboxInstance } from "./runtime-client";

const DEFAULT_SOCKET = "/var/run/docker.sock";
const RUNTIME_PORT = 8788;
const DEFAULT_NETWORK = "freebuff-sandbox-egress";
const BYTES_PER_MB = 1024 * 1024;

export interface DockerHostConfigOptions {
  readonly networkName: string;
  readonly workspaceMb: number;
}

/**
 * Hardened container configuration. This is the isolation boundary for local and CI runs, so the
 * flags are generated from the spec rather than hand-written per deployment:
 *
 * - read-only root filesystem, with only the workspace and /tmp as tmpfs
 * - all capabilities dropped, `no-new-privileges`, unprivileged uid
 * - memory, CPU, PID and file-descriptor ceilings
 * - egress only through the internal allowlist network (no default route), so a blocked host is
 *   unreachable even if the process ignores proxy settings
 */
export function buildDockerHostConfig(
  spec: SandboxSpec,
  options: DockerHostConfigOptions,
): Record<string, unknown> {
  return {
    ReadonlyRootfs: true,
    // uid/gid 1000 is the image's unprivileged user: a root-owned tmpfs would leave the runtime
    // unable to write its own workspace.
    Tmpfs: {
      "/workspace": `rw,noexec,nosuid,nodev,size=${String(options.workspaceMb)}m,uid=1000,gid=1000`,
      "/tmp": "rw,noexec,nosuid,nodev,size=64m,uid=1000,gid=1000",
      "/run": "rw,noexec,nosuid,nodev,size=8m,uid=1000,gid=1000",
    },
    CapDrop: ["ALL"],
    SecurityOpt: ["no-new-privileges:true"],
    Privileged: false,
    Memory: spec.resources.memoryMb * BYTES_PER_MB,
    MemorySwap: spec.resources.memoryMb * BYTES_PER_MB,
    NanoCpus: Math.round(spec.resources.cpuCores * 1_000_000_000),
    PidsLimit: spec.resources.pidsLimit,
    Ulimits: [{ Name: "nofile", Soft: 4096, Hard: 8192 }],
    NetworkMode: spec.egress.mode === "open" ? "bridge" : options.networkName,
    PortBindings: {
      [`${String(RUNTIME_PORT)}/tcp`]: [{ HostIp: "127.0.0.1", HostPort: "" }],
    },
    AutoRemove: false,
  };
}

export function buildDockerContainerConfig(
  spec: SandboxSpec,
  options: DockerHostConfigOptions & { readonly sandboxId: string; readonly token: string },
): Record<string, unknown> {
  return {
    Image: spec.image,
    User: "1000:1000",
    WorkingDir: "/workspace",
    Env: [
      `SANDBOX_ID=${options.sandboxId}`,
      `SANDBOX_HTTP_PORT=${String(RUNTIME_PORT)}`,
      `SANDBOX_TOKEN=${options.token}`,
      `SANDBOX_EGRESS_MODE=${spec.egress.mode}`,
      ...Object.entries(spec.env ?? {}).map(([key, value]) => `${key}=${value}`),
    ],
    ExposedPorts: { [`${String(RUNTIME_PORT)}/tcp`]: {} },
    Labels: { "freebuff.sandbox": options.sandboxId, "freebuff.managed": "true" },
    HostConfig: buildDockerHostConfig(spec, options),
  };
}

export interface DockerProviderOptions {
  readonly socketPath?: string;
  readonly image: string;
  readonly networkName?: string;
  readonly timeoutMs?: number;
}

interface DockerResponse {
  readonly status: number;
  readonly body: string;
}

function dockerRequest(
  socketPath: string,
  method: "DELETE" | "GET" | "POST",
  path: string,
  body?: unknown,
  timeoutMs = 30_000,
): Promise<DockerResponse> {
  const payload = body === undefined ? undefined : JSON.stringify(body);

  return new Promise<DockerResponse>((resolve, reject) => {
    const req = request(
      {
        socketPath,
        path,
        method,
        headers: {
          accept: "application/json",
          ...(payload === undefined
            ? {}
            : { "content-type": "application/json", "content-length": Buffer.byteLength(payload) }),
        },
        timeout: timeoutMs,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") });
        });
      },
    );
    req.on("timeout", () => {
      req.destroy(new Error("Docker API request timed out."));
    });
    req.on("error", (error) => {
      reject(
        new SandboxError("not_configured", "Cannot reach the Docker daemon.", { cause: error }),
      );
    });
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}

interface InspectResult {
  readonly NetworkSettings?: {
    readonly Ports?: Record<string, readonly { readonly HostPort?: string }[] | null>;
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Docker provider: one hardened container per sandbox, with the sandbox runtime inside it.
 *
 * The container is the security boundary (see `buildDockerHostConfig`); exec, file access and the
 * preview all go through the runtime's token-authenticated control API, so the orchestrator never
 * executes anything on the host.
 */
export class DockerProvider implements SandboxProvider {
  readonly name = "docker";
  readonly isolation = "container" as const;
  readonly #socketPath: string;
  readonly #image: string;
  readonly #networkName: string;
  readonly #timeoutMs: number;

  constructor(options: DockerProviderOptions) {
    this.#socketPath = options.socketPath ?? DEFAULT_SOCKET;
    this.#image = options.image;
    this.#networkName = options.networkName ?? DEFAULT_NETWORK;
    this.#timeoutMs = options.timeoutMs ?? 30_000;
  }

  async create(options: { readonly spec: SandboxSpec }): Promise<SandboxInstance> {
    const id = createId("sandbox");
    const token = randomBytes(24).toString("hex");
    // The image must contain the sandbox runtime, so the provider owns the choice: a spec cannot
    // point a Docker sandbox at an arbitrary image that lacks the control API.
    const spec: SandboxSpec = { ...options.spec, image: this.#image };

    const workspaceMb = Math.max(64, spec.resources.diskMb);
    const created = await dockerRequest(
      this.#socketPath,
      "POST",
      `/containers/create?name=freebuff-${id}`,
      buildDockerContainerConfig(spec, {
        sandboxId: id,
        token,
        networkName: this.#networkName,
        workspaceMb,
      }),
      this.#timeoutMs,
    );

    if (created.status !== 201) {
      throw new SandboxError("internal", `Docker refused to create the sandbox: ${created.body}`);
    }

    let containerId: string;
    try {
      const parsed = JSON.parse(created.body) as { Id?: unknown };
      if (typeof parsed.Id !== "string") throw new Error("missing id");
      containerId = parsed.Id;
    } catch (error) {
      throw new SandboxError("internal", "Docker returned an unexpected create response.", {
        cause: error,
      });
    }

    const remove = async (): Promise<void> => {
      await dockerRequest(this.#socketPath, "POST", `/containers/${containerId}/stop?t=2`).catch(
        () => undefined,
      );
      const removed = await dockerRequest(
        this.#socketPath,
        "DELETE",
        `/containers/${containerId}?force=1&v=1`,
        undefined,
        this.#timeoutMs,
      );
      if (removed.status >= 400 && removed.status !== 404) {
        throw new SandboxError("internal", `Docker failed to remove the sandbox: ${removed.body}`);
      }
    };

    const started = await dockerRequest(
      this.#socketPath,
      "POST",
      `/containers/${containerId}/start`,
    );
    if (started.status >= 400 && started.status !== 304) {
      await remove().catch(() => undefined);
      throw new SandboxError("internal", `Docker failed to start the sandbox: ${started.body}`);
    }

    const inspect = await dockerRequest(this.#socketPath, "GET", `/containers/${containerId}/json`);
    if (inspect.status !== 200) {
      await remove().catch(() => undefined);
      throw new SandboxError("internal", `Docker failed to inspect the sandbox: ${inspect.body}`);
    }

    let hostPort: string | undefined;
    try {
      const parsed = JSON.parse(inspect.body) as InspectResult;
      hostPort = parsed.NetworkSettings?.Ports?.[`${String(RUNTIME_PORT)}/tcp`]?.[0]?.HostPort;
    } catch (error) {
      await remove().catch(() => undefined);
      throw new SandboxError("internal", "Docker returned an unexpected inspect response.", {
        cause: error,
      });
    }

    if (hostPort === undefined || hostPort === "") {
      await remove().catch(() => undefined);
      throw new SandboxError("internal", "Docker published no sandbox runtime port.");
    }

    const runtime = new SandboxRuntimeClient({
      origin: `http://127.0.0.1:${hostPort}`,
      token,
    });

    const readyDeadline = Date.now() + 20_000;
    for (;;) {
      try {
        const response = await fetch(`http://127.0.0.1:${hostPort}/health`, {
          signal: AbortSignal.timeout(1_500),
        });
        if (response.ok) break;
      } catch {
        // Not up yet.
      }
      if (Date.now() > readyDeadline) {
        await remove().catch(() => undefined);
        throw new SandboxError("timeout", "The sandbox runtime did not become healthy.");
      }
      await sleep(100);
    }

    // Fail at creation with a precise message if the workspace is not writable, rather than
    // surfacing an opaque 500 on the first file operation.
    try {
      await runtime.writeFile(".freebuff-probe", "ok");
      await runtime.readFile(".freebuff-probe");
    } catch (error) {
      await remove().catch(() => undefined);
      throw new SandboxError(
        "internal",
        "The sandbox workspace is not writable by the runtime (check tmpfs ownership).",
        { cause: error },
      );
    }

    return createRemoteSandboxInstance({
      id,
      isolation: "container",
      spec,
      runtime,
      dispose: remove,
    });
  }
}
