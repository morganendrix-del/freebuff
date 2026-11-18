import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { createId } from "@freebuff/shared";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import {
  ConfigStore,
  anonClient,
  authenticatedClient,
  bootstrapWorkspace,
  planWorkspaceView,
  registerCurrentProject,
  signIn,
  startLocalPlatform,
} from "@freebuff/cli";
import type { LocalPlatform } from "@freebuff/cli";

const cleanup: (() => Promise<void>)[] = [];

afterEach(async () => {
  while (cleanup.length > 0) {
    const task = cleanup.pop();
    if (task !== undefined) await task();
  }
});

async function tempDir(prefix: string): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), prefix));
  cleanup.push(async () => {
    await rm(directory, { recursive: true, force: true });
  });
  return directory;
}

async function authenticatedAgainst(platform: LocalPlatform, home: string) {
  const store = new ConfigStore({ directory: home });
  store.write({ platformUrl: platform.url });
  await signIn({ store, client: anonClient(store), email: "dev@example.com" });
  return authenticatedClient(store);
}

describe("workspace bootstrap (first-time user)", () => {
  test("registers the current directory on a fresh account and opens chat in it", async () => {
    const home = await tempDir("freebuff-boot-home-");
    const repo = await tempDir("freebuff-boot-repo-");
    const platform = await startLocalPlatform({ storePath: path.join(home, "platform.json") });
    cleanup.push(async () => {
      await platform.close();
    });
    const client = await authenticatedAgainst(platform, home);

    expect(await client.projects.list()).toHaveLength(0);

    const bootstrap = await bootstrapWorkspace({ client, rootPath: repo });
    expect(bootstrap.registered).toBe(true);
    expect(bootstrap.project?.rootPath).toBe(path.resolve(repo));
    expect(bootstrap.projects.map((project) => project.id)).toEqual([bootstrap.project?.id]);
    expect(await client.projects.list()).toHaveLength(1);

    const view = planWorkspaceView(bootstrap);
    expect(view.phase).toBe("ready");
    expect(view.activeProject?.id).toBe(bootstrap.project?.id);
    expect(view.statusLine).toContain("Registered");
  });

  test("reuses the existing project instead of registering a duplicate", async () => {
    const home = await tempDir("freebuff-boot-home2-");
    const repo = await tempDir("freebuff-boot-repo2-");
    const platform = await startLocalPlatform({ storePath: path.join(home, "platform.json") });
    cleanup.push(async () => {
      await platform.close();
    });
    const client = await authenticatedAgainst(platform, home);

    const first = await bootstrapWorkspace({ client, rootPath: repo });
    const second = await bootstrapWorkspace({ client, rootPath: repo });

    expect(second.registered).toBe(false);
    expect(second.project?.id).toBe(first.project?.id);
    expect(await client.projects.list()).toHaveLength(1);
    expect(planWorkspaceView(second).phase).toBe("ready");
  });

  test("offers the picker when other projects exist and registers this directory on request", async () => {
    const home = await tempDir("freebuff-boot-home3-");
    const other = await tempDir("freebuff-other-");
    const repo = await tempDir("freebuff-current-");
    await mkdir(path.join(repo, "src"), { recursive: true });

    const platform = await startLocalPlatform({ storePath: path.join(home, "platform.json") });
    cleanup.push(async () => {
      await platform.close();
    });
    const client = await authenticatedAgainst(platform, home);
    await client.projects.register({ name: "other", rootPath: other });

    const bootstrap = await bootstrapWorkspace({ client, rootPath: repo });
    expect(bootstrap.registered).toBe(false);
    expect(bootstrap.project).toBeUndefined();
    expect(bootstrap.projects).toHaveLength(1);

    const view = planWorkspaceView(bootstrap);
    expect(view.phase).toBe("picking_project");
    expect(view.activeProject).toBeUndefined();
    expect(view.statusLine).toContain("register this directory");

    // The picker's "register this directory" entry performs the same operation the test asserts on.
    const registered = await registerCurrentProject({ client, rootPath: repo });
    expect(registered.rootPath).toBe(path.resolve(repo));
    expect(await client.projects.list()).toHaveLength(2);
    expect(planWorkspaceView(await bootstrapWorkspace({ client, rootPath: repo })).phase).toBe(
      "ready",
    );
  });

  test("the view planner keeps a single project selected without a picker", () => {
    const project = {
      id: createId("project"),
      name: "only",
      rootPath: "/tmp/only",
    };

    expect(planWorkspaceView({ project, projects: [project], registered: false })).toMatchObject({
      phase: "ready",
      activeProject: project,
    });
  });
});
