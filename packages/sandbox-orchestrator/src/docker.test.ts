import { describe, expect, test } from "vitest";

import type { SandboxSpec } from "@freebuff/shared";

import { buildDockerContainerConfig, buildDockerHostConfig } from "./docker";
import { buildSandboxSpec } from "./lifecycle";

const spec = buildSandboxSpec({
  repo: { provider: "github", owner: "acme", name: "demo" },
  resources: { cpuCores: 3, memoryMb: 1024, diskMb: 512, pidsLimit: 128, ttlSeconds: 600 },
  egress: {
    mode: "allowlist",
    allow: [{ host: "registry.npmjs.org", ports: [443] }],
  },
});

const hostOptions = {
  networkName: "freebuff-egress",
  workspaceMb: 512,
  controlDir: "/tmp/freebuff-control",
};

describe("docker isolation config", () => {
  test("mounts a read-only root filesystem and drops every capability", () => {
    const config = buildDockerHostConfig(spec, hostOptions);

    expect(config.ReadonlyRootfs).toBe(true);
    expect(config.CapDrop).toEqual(["ALL"]);
    expect(config.SecurityOpt).toEqual(["no-new-privileges:true"]);
    expect(config.Privileged).toBe(false);
  });

  test("converts resource limits into kernel limits", () => {
    const config = buildDockerHostConfig(spec, hostOptions);

    expect(config.Memory).toBe(1024 * 1024 * 1024);
    expect(config.MemorySwap).toBe(1024 * 1024 * 1024);
    expect(config.NanoCpus).toBe(3_000_000_000);
    expect(config.PidsLimit).toBe(128);
    expect(config.Ulimits).toEqual([{ Name: "nofile", Soft: 4096, Hard: 8192 }]);
  });

  test("keeps the workspace on a bounded tmpfs and the control channel on a socket", () => {
    const config = buildDockerHostConfig(spec, hostOptions);
    const tmpfs = config.Tmpfs as Record<string, string>;

    expect(tmpfs["/workspace"]).toContain("size=512m");
    expect(tmpfs["/workspace"]).toContain("noexec");
    // The tmpfs must belong to the image's unprivileged user or the runtime cannot write it.
    expect(tmpfs["/workspace"]).toContain("uid=1000");
    expect(tmpfs["/tmp"]).toContain("gid=1000");

    // Docker does not publish ports on an internal network, so the control API is a mounted socket.
    expect(config.Binds).toEqual(["/tmp/freebuff-control:/run/sandbox:rw"]);
    expect(config.PortBindings).toBeUndefined();
  });

  test("routes allowlisted sandboxes through the internal network only", () => {
    const config = buildDockerHostConfig(spec, hostOptions);
    expect(config.NetworkMode).toBe("freebuff-egress");

    const open = buildDockerHostConfig(
      { ...spec, egress: { mode: "open", allow: [] } } satisfies SandboxSpec,
      hostOptions,
    );
    expect(open.NetworkMode).toBe("bridge");
  });

  test("passes the runtime token in the environment, never in labels", () => {
    const container = buildDockerContainerConfig(spec, {
      ...hostOptions,
      sandboxId: "sandbox_abc",
      token: "runtime-token",
    });

    expect(container.Env).toContain("SANDBOX_TOKEN=runtime-token");
    expect(container.Env).toContain("SANDBOX_CONTROL_SOCKET=/run/sandbox/control.sock");
    expect(container.Env).toContain("SANDBOX_EGRESS_MODE=allowlist");
    expect(container.User).toBe("1000:1000");
    expect(JSON.stringify(container.Labels)).not.toContain("runtime-token");
  });
});
