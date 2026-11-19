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

describe("docker isolation config", () => {
  test("mounts a read-only root filesystem and drops every capability", () => {
    const config = buildDockerHostConfig(spec, {
      networkName: "freebuff-egress",
      workspaceMb: 512,
    });

    expect(config.ReadonlyRootfs).toBe(true);
    expect(config.CapDrop).toEqual(["ALL"]);
    expect(config.SecurityOpt).toEqual(["no-new-privileges:true"]);
    expect(config.Privileged).toBe(false);
  });

  test("converts resource limits into kernel limits", () => {
    const config = buildDockerHostConfig(spec, {
      networkName: "freebuff-egress",
      workspaceMb: 512,
    });

    expect(config.Memory).toBe(1024 * 1024 * 1024);
    expect(config.MemorySwap).toBe(1024 * 1024 * 1024);
    expect(config.NanoCpus).toBe(3_000_000_000);
    expect(config.PidsLimit).toBe(128);
    expect(config.Ulimits).toEqual([{ Name: "nofile", Soft: 4096, Hard: 8192 }]);
  });

  test("keeps the workspace on a bounded tmpfs and the control port on loopback", () => {
    const config = buildDockerHostConfig(spec, {
      networkName: "freebuff-egress",
      workspaceMb: 512,
    });
    const tmpfs = config.Tmpfs as Record<string, string>;

    expect(tmpfs["/workspace"]).toContain("size=512m");
    expect(tmpfs["/workspace"]).toContain("noexec");
    expect(config.PortBindings).toEqual({
      "8788/tcp": [{ HostIp: "127.0.0.1", HostPort: "" }],
    });
  });

  test("routes allowlisted sandboxes through the internal network only", () => {
    const config = buildDockerHostConfig(spec, {
      networkName: "freebuff-egress",
      workspaceMb: 512,
    });
    expect(config.NetworkMode).toBe("freebuff-egress");

    const open = buildDockerHostConfig(
      { ...spec, egress: { mode: "open", allow: [] } } satisfies SandboxSpec,
      { networkName: "freebuff-egress", workspaceMb: 512 },
    );
    expect(open.NetworkMode).toBe("bridge");
  });

  test("passes the runtime token in the environment, never in labels", () => {
    const container = buildDockerContainerConfig(spec, {
      sandboxId: "sandbox_abc",
      token: "runtime-token",
      networkName: "freebuff-egress",
      workspaceMb: 512,
    });

    expect(container.Env).toContain("SANDBOX_TOKEN=runtime-token");
    expect(container.Env).toContain("SANDBOX_EGRESS_MODE=allowlist");
    expect(container.User).toBe("1000:1000");
    expect(JSON.stringify(container.Labels)).not.toContain("runtime-token");
  });
});
