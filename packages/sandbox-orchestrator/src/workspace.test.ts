import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import { SandboxError } from "./errors";
import { WorkspaceJail } from "./workspace";

const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  while (cleanups.length > 0) {
    const task = cleanups.pop();
    if (task !== undefined) await task();
  }
});

async function jail(options: { maxFileBytes?: number } = {}): Promise<WorkspaceJail> {
  const base = await mkdtemp(path.join(tmpdir(), "freebuff-jail-"));
  cleanups.push(async () => {
    await rm(base, { recursive: true, force: true });
  });
  const instance = new WorkspaceJail(path.join(base, "workspace"), options);
  await instance.init();
  return instance;
}

describe("workspace jail", () => {
  test("round-trips files inside the workspace", async () => {
    const workspace = await jail();
    await workspace.write("src/index.ts", "export const value = 1;\n");

    await expect(workspace.read("src/index.ts")).resolves.toBe("export const value = 1;\n");
    await expect(workspace.exists("src/index.ts")).resolves.toBe(true);
    await expect(workspace.list()).resolves.toEqual(["src/index.ts"]);
  });

  test("rejects parent traversal and absolute paths", async () => {
    const workspace = await jail();

    expect(() => workspace.resolve("../outside.txt")).toThrow(SandboxError);
    expect(() => workspace.resolve("/etc/passwd")).toThrow(/relative to the workspace/);
    await expect(workspace.read("../../etc/passwd")).rejects.toThrow(/escapes the workspace/);
  });

  test("rejects a symlink that points outside the workspace", async () => {
    const workspace = await jail();
    const outside = path.join(tmpdir(), `freebuff-outside-${String(Date.now())}.txt`);
    await writeFile(outside, "host secret", "utf8");
    cleanups.push(async () => {
      await rm(outside, { force: true });
    });

    await symlink(outside, path.join(workspace.root, "escape"));

    await expect(workspace.read("escape")).rejects.toThrow(/outside the workspace/);
    await expect(workspace.write("escape", "overwrite")).rejects.toThrow(/outside the workspace/);
    expect(existsSync(outside)).toBe(true);
  });

  test("enforces the file size cap on reads and writes", async () => {
    const workspace = await jail({ maxFileBytes: 32 });
    await expect(workspace.write("big.txt", "x".repeat(64))).rejects.toThrow(/file cap/);

    await writeFile(path.join(workspace.root, "existing.txt"), "y".repeat(64), "utf8");
    await expect(workspace.read("existing.txt")).rejects.toThrow(/too large/);
  });

  test("skips node_modules and .git when listing", async () => {
    const workspace = await jail();
    await workspace.write("node_modules/dep/index.js", "module.exports = {};\n");
    await workspace.write(".git/config", "[core]\n");
    await workspace.write("app.js", "console.log(1);\n");

    await expect(workspace.list()).resolves.toEqual(["app.js"]);
  });
});
