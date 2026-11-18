import type { ChildProcess } from "node:child_process";
import { spawn } from "node:child_process";

import { TimeoutError } from "@freebuff/shared";
import { describe, expect, test, vi } from "vitest";

import { createLocalTerminalBroker, sanitizeEnv } from "@freebuff/cli";
import type { SpawnImpl } from "@freebuff/cli";

const spawnImpl: SpawnImpl = (command, args, options) => {
  const child: ChildProcess = spawn(command, [...args], {
    cwd: options.cwd,
    detached: options.detached,
    env: options.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  return child;
};

describe("terminal broker", () => {
  test("captures shell output on its own channel instead of the agent's stdio", async () => {
    const spy = vi.spyOn(process.stdout, "write");
    const broker = createLocalTerminalBroker({ spawnImpl });
    const session = broker.open({ cwd: process.cwd() });

    try {
      const result = await broker.exec(session.id, "printf 'out:%s' broker && printf 'err' 1>&2");
      const stdoutAtParent = spy.mock.calls.map((call) => String(call[0])).join("");

      expect(result.stdout).toBe("out:broker");
      expect(result.stderr).toBe("err");
      expect(result.exitCode).toBe(0);
      expect(stdoutAtParent).not.toContain("out:broker");
      expect(stdoutAtParent).not.toContain("err");
    } finally {
      spy.mockRestore();
      broker.closeAll();
    }
  });

  test("spawns with piped stdio, its own process group and a scrubbed environment", async () => {
    const calls: {
      command: string;
      stdio: unknown;
      detached: unknown;
      env: Record<string, string | undefined>;
    }[] = [];
    const recordingSpawn: SpawnImpl = (command, args, options) => {
      calls.push({
        command,
        stdio: options.stdio,
        detached: options.detached,
        env: { ...options.env },
      });
      return spawnImpl(command, args, options);
    };

    const broker = createLocalTerminalBroker({
      spawnImpl: recordingSpawn,
      env: { PATH: process.env.PATH, FREE_BUFF_TOKEN: "secret", DATABASE_PASSWORD: "hunter2" },
    });
    const session = broker.open({ cwd: process.cwd() });

    try {
      await broker.exec(session.id, "printf ok");
      const call = calls[0];
      expect(call?.stdio).toEqual(["ignore", "pipe", "pipe"]);
      expect(call?.detached).toBe(true);
      expect(call?.env.FREE_BUFF_TOKEN).toBeUndefined();
      expect(call?.env.DATABASE_PASSWORD).toBeUndefined();
      expect(call?.env.PATH).toBe(process.env.PATH);
    } finally {
      broker.closeAll();
    }
  });

  test("kills the process tree when a command exceeds its timeout", async () => {
    const broker = createLocalTerminalBroker({ spawnImpl, defaultTimeoutMs: 50 });
    const session = broker.open({ cwd: process.cwd() });

    try {
      const startedAt = Date.now();
      await expect(broker.exec(session.id, "sleep 30")).rejects.toBeInstanceOf(TimeoutError);
      expect(Date.now() - startedAt).toBeLessThan(5_000);
    } finally {
      broker.closeAll();
    }
  });

  test("aborts an in-flight command through the caller's signal", async () => {
    const broker = createLocalTerminalBroker({ spawnImpl });
    const session = broker.open({ cwd: process.cwd() });
    const controller = new AbortController();

    try {
      const pending = broker.exec(session.id, "sleep 30", { signal: controller.signal });
      setTimeout(() => {
        controller.abort();
      }, 20);
      await expect(pending).rejects.toMatchObject({ code: "cancelled" });
    } finally {
      broker.closeAll();
    }
  });

  test("rejects unknown sessions and empty commands", async () => {
    const broker = createLocalTerminalBroker({ spawnImpl });
    const session = broker.open({ cwd: process.cwd() });

    try {
      await expect(broker.exec("terminal_missing", "printf x")).rejects.toMatchObject({
        code: "not_found",
      });
      await expect(broker.exec(session.id, "  ")).rejects.toMatchObject({ code: "invalid_input" });
      broker.close(session.id);
      await expect(broker.exec(session.id, "printf x")).rejects.toMatchObject({
        code: "not_found",
      });
    } finally {
      broker.closeAll();
    }
  });

  test("strips credential-looking variables before spawning", () => {
    const clean = sanitizeEnv({
      PATH: "/usr/bin",
      FREE_BUFF_TOKEN: "t",
      OPENAI_API_KEY: "k",
      AWS_SECRET_ACCESS_KEY: "s",
      USER_PASSWORD: "p",
      HOME: "/home/dev",
    });

    expect(clean).toEqual({ PATH: "/usr/bin", HOME: "/home/dev" });
  });
});
