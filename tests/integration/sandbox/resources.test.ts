import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import { runCommand } from "../../../packages/sandbox-orchestrator/src/exec";
import { createSandboxRuntime } from "../../../packages/sandbox-orchestrator/src/runtime/index";

const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  while (cleanups.length > 0) {
    const task = cleanups.pop();
    if (task !== undefined) await task();
  }
});

async function workdir(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "freebuff-resources-"));
  cleanups.push(async () => {
    await rm(directory, { recursive: true, force: true });
  });
  return directory;
}

describe("resource isolation", () => {
  test("kills a command that exceeds its wall-clock deadline", async () => {
    const cwd = await workdir();
    const started = Date.now();

    const result = await runCommand({
      command: "sleep 30; echo never",
      cwd,
      timeoutMs: 400,
    });

    const elapsed = Date.now() - started;
    expect(result.timedOut).toBe(true);
    expect(result.stdout).not.toContain("never");
    expect(elapsed).toBeLessThan(5_000);
  }, 15_000);

  test("caps captured output instead of buffering it all", async () => {
    const cwd = await workdir();

    const result = await runCommand({
      command: "yes freebuff-output-flood",
      cwd,
      timeoutMs: 1_500,
      maxOutputBytes: 4_096,
    });

    expect(result.truncated).toBe(true);
    expect(Buffer.byteLength(result.stdout)).toBeLessThanOrEqual(4_096);
    expect(result.timedOut).toBe(true);
  }, 15_000);

  test("enforces the file-size limit through ulimit", async () => {
    const cwd = await workdir();

    const result = await runCommand({
      command: "head -c 5000000 /dev/zero > big.bin; echo done",
      cwd,
      timeoutMs: 15_000,
      limits: { fileSizeMb: 1 },
    });

    // The write is cut off at the limit: `head` is killed by SIGXFSZ, so the file stays bounded even
    // though the shell continues to the next statement.
    expect(result.stderr).toContain("File size limit exceeded");
    const size = await stat(path.join(cwd, "big.bin"))
      .then((info) => info.size)
      .catch(() => 0);
    expect(size).toBeGreaterThan(0);
    expect(size).toBeLessThanOrEqual(2 * 1024 * 1024);
  }, 20_000);

  test("enforces the memory limit so an allocation cannot take the host down", async () => {
    const cwd = await workdir();

    const result = await runCommand({
      command: "node -e 'const buffer = Buffer.alloc(800 * 1024 * 1024); buffer.fill(1);'",
      cwd,
      timeoutMs: 20_000,
      limits: { memoryMb: 256 },
    });

    expect(result.exitCode).not.toBe(0);
  }, 25_000);

  test("rejects a command timeout above the runtime's own ceiling", async () => {
    const base = await workdir();
    const runtime = await createSandboxRuntime({
      workspace: path.join(base, "workspace"),
      limits: { commandTimeoutMs: 5_000 },
    });
    cleanups.push(async () => {
      await runtime.release();
    });

    const response = await runtime.handle(
      new Request("http://sandbox.local/exec", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ command: "echo hi", timeoutMs: 60_000 }),
      }),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "invalid_input" },
    });
  });

  test("rejects oversized request bodies at the control API", async () => {
    const base = await workdir();
    const runtime = await createSandboxRuntime({ workspace: path.join(base, "workspace") });
    cleanups.push(async () => {
      await runtime.release();
    });

    const response = await runtime.handle(
      new Request("http://sandbox.local/files/write", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path: "big.txt", content: "x".repeat(600 * 1024) }),
      }),
    );

    expect(response.status).toBe(413);
  });
});
