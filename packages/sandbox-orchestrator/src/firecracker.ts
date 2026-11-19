import { request } from "node:http";

import { createId } from "@freebuff/shared";
import type { SandboxSpec } from "@freebuff/shared";

import { SandboxError } from "./errors";
import type { SandboxInstance, SandboxProvider } from "./provider";
import { SandboxRuntimeClient, createRemoteSandboxInstance } from "./runtime-client";

const GUEST_RUNTIME_PORT = 8788;
const MB = 1024 * 1024;

export interface FirecrackerVmConfig {
  readonly vcpuCount: number;
  readonly memoryMb: number;
  readonly kernelArgs: string;
  readonly bootSource: { readonly kernelImagePath: string; readonly bootArgs: string };
  readonly drives: readonly {
    readonly driveId: string;
    readonly pathOnHost: string;
    readonly isRootDevice: boolean;
    readonly isReadOnly: boolean;
  }[];
  readonly networkInterfaces: readonly {
    readonly ifaceId: string;
    readonly hostDevName: string;
    readonly guestMac: string;
  }[];
  readonly vsock: { readonly guestCid: number; readonly udsPath: string };
}

export interface FirecrackerVmInput {
  readonly kernelImagePath: string;
  readonly rootfsImagePath: string;
  readonly memoryMb: number;
  readonly vcpuCount: number;
  readonly tapDevice: string;
  readonly guestMac: string;
  readonly vsockSocketPath: string;
  readonly guestCid: number;
}

/**
 * VM definition for a Firecracker microVM.
 *
 * The root filesystem is mounted read-only; the workspace is a second writable drive created per
 * sandbox from a fresh sparse image. Networking uses a per-VM tap device on an isolated host bridge,
 * so the guest's only route out is the allowlist proxy — the same policy object as the container
 * path, enforced one layer lower.
 */
export function buildFirecrackerVmConfig(input: FirecrackerVmInput): FirecrackerVmConfig {
  const bootArgs = [
    "console=ttyS0",
    "reboot=k",
    "panic=1",
    "pci=off",
    "init=/sbin/tini -- /opt/sandbox/entrypoint",
    "ip=172.16.0.2::172.16.0.1:255.255.255.0::eth0:off",
  ].join(" ");

  return {
    vcpuCount: input.vcpuCount,
    memoryMb: input.memoryMb,
    kernelArgs: bootArgs,
    bootSource: { kernelImagePath: input.kernelImagePath, bootArgs },
    drives: [
      {
        driveId: "rootfs",
        pathOnHost: input.rootfsImagePath,
        isRootDevice: true,
        isReadOnly: true,
      },
      {
        driveId: "workspace",
        pathOnHost: `${input.rootfsImagePath}.workspace`,
        isRootDevice: false,
        isReadOnly: false,
      },
    ],
    networkInterfaces: [
      { ifaceId: "eth0", hostDevName: input.tapDevice, guestMac: input.guestMac },
    ],
    vsock: { guestCid: input.guestCid, udsPath: input.vsockSocketPath },
  };
}

export interface FirecrackerProviderOptions {
  /** Firecracker API socket for the host agent (`/run/firecracker/<id>/api.sock`). */
  readonly apiSocketPath: string;
  readonly kernelImagePath: string;
  readonly rootfsImagePath: string;
  readonly guestIp: string;
  readonly guestCid: number;
}

interface FirecrackerReply {
  readonly status: number;
  readonly body: string;
}

function firecrackerRequest(
  socketPath: string,
  method: "PATCH" | "PUT",
  path: string,
  body: unknown,
): Promise<FirecrackerReply> {
  const payload = JSON.stringify(body);

  return new Promise<FirecrackerReply>((resolve, reject) => {
    const req = request(
      {
        socketPath,
        path,
        method,
        headers: {
          "content-type": "application/json",
          "content-length": Buffer.byteLength(payload),
        },
        timeout: 10_000,
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
      req.destroy(new Error("Firecracker API request timed out."));
    });
    req.on("error", (error) => {
      reject(
        new SandboxError("not_configured", "Cannot reach the Firecracker API socket.", {
          cause: error,
        }),
      );
    });
    req.write(payload);
    req.end();
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Firecracker provider: the production isolation boundary. Each sandbox is its own microVM with a
 * read-only rootfs, a dedicated workspace drive and a tap device behind the egress allowlist.
 *
 * It needs a Firecracker host (KVM, jailer, pre-baked kernel and rootfs). Neither exists in local
 * development or on the CI runners used by this repository, so this path is configured and reviewed
 * but exercised only in the staging environment — `DockerProvider` is what the integration tests and
 * the gate run against.
 */
export class FirecrackerProvider implements SandboxProvider {
  readonly name = "firecracker";
  readonly isolation = "microvm" as const;
  readonly #options: FirecrackerProviderOptions;

  constructor(options: FirecrackerProviderOptions) {
    this.#options = options;
  }

  async create(options: { readonly spec: SandboxSpec }): Promise<SandboxInstance> {
    const id = createId("sandbox");
    const vm = buildFirecrackerVmConfig({
      kernelImagePath: this.#options.kernelImagePath,
      rootfsImagePath: this.#options.rootfsImagePath,
      memoryMb: options.spec.resources.memoryMb,
      vcpuCount: options.spec.resources.cpuCores,
      tapDevice: `tap-${id.slice(-8)}`,
      guestMac: "06:00:AC:10:00:02",
      vsockSocketPath: `/run/firecracker/${id}/vsock.sock`,
      guestCid: this.#options.guestCid,
    });

    const configure: readonly { path: string; body: unknown }[] = [
      {
        path: "/machine-config",
        body: { vcpu_count: vm.vcpuCount, mem_size_mib: vm.memoryMb, smt: false },
      },
      { path: "/boot-source", body: vm.bootSource },
      ...vm.drives.map((drive) => ({
        path: `/drives/${drive.driveId}`,
        body: {
          drive_id: drive.driveId,
          path_on_host: drive.pathOnHost,
          is_root_device: drive.isRootDevice,
          is_read_only: drive.isReadOnly,
        },
      })),
      ...vm.networkInterfaces.map((iface) => ({
        path: `/network-interfaces/${iface.ifaceId}`,
        body: {
          iface_id: iface.ifaceId,
          host_dev_name: iface.hostDevName,
          guest_mac: iface.guestMac,
        },
      })),
      {
        path: "/vsock",
        body: { guest_cid: vm.vsock.guestCid, uds_path: vm.vsock.udsPath },
      },
    ];

    for (const step of configure) {
      const reply = await firecrackerRequest(
        this.#options.apiSocketPath,
        "PUT",
        step.path,
        step.body,
      );
      if (reply.status >= 400) {
        throw new SandboxError("internal", `Firecracker rejected ${step.path}: ${reply.body}`);
      }
    }

    const booted = await firecrackerRequest(this.#options.apiSocketPath, "PUT", "/actions", {
      action_type: "InstanceStart",
    });
    if (booted.status >= 400) {
      throw new SandboxError("internal", `Firecracker failed to boot the VM: ${booted.body}`);
    }

    const runtime = new SandboxRuntimeClient({
      origin: `http://${this.#options.guestIp}:${String(GUEST_RUNTIME_PORT)}`,
    });

    const deadline = Date.now() + 30_000;
    for (;;) {
      try {
        const response = await fetch(
          `http://${this.#options.guestIp}:${String(GUEST_RUNTIME_PORT)}/health`,
          { signal: AbortSignal.timeout(1_500) },
        );
        if (response.ok) break;
      } catch {
        // Guest still booting.
      }
      if (Date.now() > deadline) {
        throw new SandboxError("timeout", "The microVM runtime did not become healthy.");
      }
      await sleep(200);
    }

    return createRemoteSandboxInstance({
      id,
      isolation: "microvm",
      spec: options.spec,
      runtime,
      dispose: async () => {
        await firecrackerRequest(this.#options.apiSocketPath, "PATCH", "/vm", {
          state: "Paused",
        }).catch(() => undefined);
      },
    });
  }
}

/** Default workspace drive size in MiB for a microVM sandbox. */
export function workspaceDriveSizeMb(spec: SandboxSpec): number {
  return Math.max(512, Math.ceil((spec.resources.diskMb * MB) / MB));
}
