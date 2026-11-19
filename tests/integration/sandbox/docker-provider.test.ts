import { afterEach, describe, expect, test } from "vitest";

import { DockerProvider, buildSandboxSpec } from "@freebuff/sandbox-orchestrator";
import type { SandboxInstance } from "@freebuff/sandbox-orchestrator";

/**
 * Exercises `DockerProvider` against a real Docker daemon. This environment has no daemon, so the
 * suite is skipped locally and runs in CI (`sandbox-docker-provider`), where it proves that the
 * generated HostConfig actually boots and that exec/files travel through the runtime control API.
 */
const enabled = process.env.FREEBUFF_DOCKER_TESTS === "1";
const image = process.env.SANDBOX_IMAGE ?? "freebuff/sandbox:ci";
const network = process.env.SANDBOX_NETWORK ?? "freebuff-sandbox-egress";

const instances: SandboxInstance[] = [];

afterEach(async () => {
  while (instances.length > 0) {
    const instance = instances.pop();
    if (instance !== undefined) await instance.stop().catch(() => undefined);
  }
});

describe.skipIf(!enabled)("docker sandbox provider", () => {
  test("runs commands unprivileged inside a read-only container and cleans up", async () => {
    const provider = new DockerProvider({ image, networkName: network });
    const instance = await provider.create({
      spec: buildSandboxSpec({
        repo: { provider: "github", owner: "acme", name: "demo" },
        egress: { mode: "deny_all", allow: [] },
        resources: { cpuCores: 1, memoryMb: 512, diskMb: 256, pidsLimit: 128, ttlSeconds: 120 },
      }),
    });
    instances.push(instance);

    const result = await instance.exec({
      command: "id -u; printf docker-marker",
      timeoutMs: 30_000,
    });
    expect(result.stdout).toContain("docker-marker");
    const uid = result.stdout.split("\n")[0];
    expect(uid).toBeDefined();
    expect(uid).not.toBe("0");

    await instance.writeFile("note.txt", "hello from the orchestrator");
    await expect(instance.readFile("note.txt")).resolves.toBe("hello from the orchestrator");

    const outside = await instance.exec({
      command: "touch /rootfs-probe 2>&1; printf done",
      timeoutMs: 10_000,
    });
    expect(outside.stdout).toContain("Read-only file system");

    const escape = await instance
      .readFile("../etc/passwd")
      .then(() => "read")
      .catch(() => "denied");
    expect(escape).toBe("denied");
  }, 180_000);
});
