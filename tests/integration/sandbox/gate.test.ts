import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import { ProcessProvider, SandboxManager } from "@freebuff/sandbox-orchestrator";
import type { SandboxRecord } from "@freebuff/sandbox-orchestrator";

import { createFixtureRepository } from "./helpers";
import type { FixtureRepository } from "./helpers";

const cleanups: (() => Promise<void>)[] = [];
let fixture: FixtureRepository | undefined;

afterEach(async () => {
  while (cleanups.length > 0) {
    const task = cleanups.pop();
    if (task !== undefined) await task();
  }
});

async function sandboxRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "freebuff-sandboxes-"));
  cleanups.push(async () => {
    await rm(root, { recursive: true, force: true });
  });
  return root;
}

describe("phase 3 gate: public repository to reachable preview", () => {
  test("clones, installs, launches and serves a preview in under 120 seconds", async () => {
    fixture = await createFixtureRepository();
    cleanups.push(fixture.cleanup);
    const manager = new SandboxManager({
      provider: new ProcessProvider({ root: await sandboxRoot() }),
    });
    const startedAt = Date.now();

    const record = await manager.create({
      repo: { provider: "github", owner: "acme", name: "demo" },
      cloneUrl: fixture.cloneUrl,
    });
    const elapsedMs = Date.now() - startedAt;

    expect(record.failure).toBeUndefined();
    expect(record.status).toBe("ready");
    expect(record.isolation).toBe("process");
    expect(record.stack).toMatchObject({ stack: "bun", devCommand: "node server.mjs" });
    expect(record.previewUrl).toBeDefined();
    expect(record.previewPort).toBeDefined();

    // The gate: reachable in under two minutes.
    expect(elapsedMs).toBeLessThan(120_000);

    const response = await fetch(record.previewUrl ?? "");
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain("freebuff preview ok");

    const stages = record.stages.map((stage) => stage.stage);
    expect(stages).toEqual(["cloning", "installing", "starting"]);
    const accounttedMs = record.stages.reduce((sum, stage) => sum + stage.durationMs, 0);
    expect(accounttedMs).toBeLessThanOrEqual(elapsedMs + 50);

    const instance = manager.instance(record.id);
    expect(instance).toBeDefined();
    const files = await instance?.listFiles();
    expect(files).toContain("package.json");
    expect(files).toContain("server.mjs");

    // The preview is served through the sandbox proxy path used by the cloud API.
    const proxied = await instance?.proxyPreview(new Request("http://sandbox.local/from-proxy"));
    expect(await proxied?.text()).toContain("/from-proxy");

    const stopped = await manager.stop(record.id);
    expect(stopped?.status).toBe("stopped");
    expect(manager.instance(record.id)).toBeUndefined();
    await expect(fetch(record.previewUrl ?? "")).rejects.toThrow();
  }, 180_000);

  test("records where a failing pipeline stopped", async () => {
    const manager = new SandboxManager({
      provider: new ProcessProvider({ root: await sandboxRoot() }),
    });

    const record: SandboxRecord = await manager.create({
      repo: { provider: "github", owner: "acme", name: "missing" },
      // A local path that does not exist: clone fails immediately, with no network dependency.
      cloneUrl: "file:///nonexistent/freebuff-missing-repository.git",
      previewCommand: "node server.mjs",
    });

    expect(record.status).toBe("failed");
    expect(record.failure?.stage).toBe("cloning");
    expect(record.failure?.code).toBe("clone_failed");
  }, 60_000);
});
