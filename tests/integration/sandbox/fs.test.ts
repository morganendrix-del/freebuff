import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import { createSandboxRuntime } from "../../../packages/sandbox-orchestrator/src/runtime/index";
import type { SandboxRuntime } from "../../../packages/sandbox-orchestrator/src/runtime/index";

const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  while (cleanups.length > 0) {
    const task = cleanups.pop();
    if (task !== undefined) await task();
  }
});

async function runtime(): Promise<{ runtime: SandboxRuntime; workspace: string }> {
  const base = await mkdtemp(path.join(tmpdir(), "freebuff-fs-"));
  const workspace = path.join(base, "workspace");
  const instance = await createSandboxRuntime({ workspace, sandboxId: "sandbox_fs_test" });
  cleanups.push(async () => {
    await instance.release();
    await rm(base, { recursive: true, force: true });
  });
  return { runtime: instance, workspace };
}

function call(
  instance: SandboxRuntime,
  path: string,
  body: unknown,
  method = "POST",
): Promise<Response> {
  const init: RequestInit =
    method === "GET"
      ? { method, headers: { "content-type": "application/json" } }
      : {
          method,
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        };
  return instance.handle(new Request(`http://sandbox.local${path}`, init));
}

describe("filesystem isolation", () => {
  test("writes and reads stay inside the workspace", async () => {
    const { runtime: instance, workspace } = await runtime();

    const write = await call(instance, "/files/write", {
      path: "src/app.ts",
      content: "export const ok = true;\n",
    });
    expect(write.status).toBe(200);

    const read = await call(instance, "/files/read", { path: "src/app.ts" });
    await expect(read.json()).resolves.toEqual({ content: "export const ok = true;\n" });
    expect(await readFile(path.join(workspace, "src/app.ts"), "utf8")).toBe(
      "export const ok = true;\n",
    );
  });

  test("rejects traversal, absolute paths and symlinks that leave the workspace", async () => {
    const { runtime: instance, workspace } = await runtime();
    const outside = path.join(path.dirname(workspace), "outside.txt");
    await writeFile(outside, "host secret", "utf8");
    await symlink(outside, path.join(workspace, "escape"));

    const traversal = await call(instance, "/files/write", {
      path: "../escaped.txt",
      content: "nope",
    });
    expect(traversal.status).toBe(403);

    const absolute = await call(instance, "/files/read", { path: "/etc/passwd" });
    expect(absolute.status).toBe(403);

    const viaSymlink = await call(instance, "/files/read", { path: "escape" });
    expect(viaSymlink.status).toBe(403);

    const dotDot = await call(instance, "/files/read", { path: "sub/../../outside.txt" });
    expect(dotDot.status).toBe(403);

    expect(await readFile(outside, "utf8")).toBe("host secret");
  });

  test("executes commands with the workspace as cwd and no inherited host secrets", async () => {
    const { runtime: instance } = await runtime();
    await call(instance, "/files/write", { path: "marker.txt", content: "present" });

    const result = await call(instance, "/exec", {
      command: 'pwd; cat marker.txt; printf %s "${OPENAI_API_KEY:-none}"',
      timeoutMs: 10_000,
    });
    const body = (await result.json()) as { stdout: string; exitCode: number; stderr: string };

    expect(body.exitCode).toBe(0);
    expect(body.stdout).toContain("workspace");
    expect(body.stdout).toContain("present");
    // A host credential would have been visible here if the environment leaked.
    expect(body.stdout).toContain("none");
  });

  test("refuses files above the read cap", async () => {
    const { runtime: instance, workspace } = await runtime();
    await writeFile(path.join(workspace, "big.txt"), "x".repeat(600 * 1024), "utf8");

    const response = await call(instance, "/files/read", { path: "big.txt" });
    expect(response.status).toBe(413);
  });

  test("answers readiness and exposes its isolation posture", async () => {
    const { runtime: instance } = await runtime();

    const health = await call(instance, "/health", {}, "GET");
    await expect(health.json()).resolves.toEqual({ status: "ok" });

    const info = await call(instance, "/info", {}, "GET");
    const body = (await info.json()) as { isolation: string; uid: number; workspace: string };
    expect(body.workspace).toContain("workspace");
    expect(body.uid).not.toBe(0);
    expect(body.isolation).toBe("container");
  });
});
