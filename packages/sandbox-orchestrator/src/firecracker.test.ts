import { describe, expect, test } from "vitest";

import { buildFirecrackerVmConfig, workspaceDriveSizeMb } from "./firecracker";
import { buildSandboxSpec } from "./lifecycle";

describe("firecracker VM config", () => {
  test("defines a read-only root drive and a writable workspace drive", () => {
    const config = buildFirecrackerVmConfig({
      kernelImagePath: "/var/lib/firecracker/vmlinux",
      rootfsImagePath: "/var/lib/firecracker/rootfs.ext4",
      memoryMb: 2048,
      vcpuCount: 2,
      tapDevice: "tap-abc",
      guestMac: "06:00:AC:10:00:02",
      vsockSocketPath: "/run/firecracker/abc/vsock.sock",
      guestCid: 3,
    });

    expect(config.vcpuCount).toBe(2);
    expect(config.memoryMb).toBe(2048);
    expect(config.drives[0]).toMatchObject({
      driveId: "rootfs",
      isRootDevice: true,
      isReadOnly: true,
    });
    expect(config.drives[1]).toMatchObject({ driveId: "workspace", isReadOnly: false });
    expect(config.vsock.guestCid).toBe(3);
    expect(config.bootSource.bootArgs).toContain("panic=1");
    expect(config.networkInterfaces[0]?.hostDevName).toBe("tap-abc");
  });

  test("keeps the workspace drive at least 512 MiB", () => {
    const spec = buildSandboxSpec({ repo: { provider: "github", owner: "a", name: "b" } });
    expect(workspaceDriveSizeMb(spec)).toBeGreaterThanOrEqual(512);
  });
});
