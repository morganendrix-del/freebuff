import { readFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, test } from "vitest";

import { AGENT_LOOP_DEFAULTS } from "@freebuff/shared";
import { PathLockManager } from "@freebuff/agent-runtime";

import { completed, finalText, script, toolCall } from "./agent/scripted-provider";
import { runScripted, withFixtureRepo } from "./agent/harness";

describe("parallel subagents (Phase 1 gate)", () => {
  test("overlapping edits are serialised, never interleaved", async () => {
    const prompt = "Update the shared file twice";
    const first = "Write A into the shared file";
    const second = "Write B into the shared file";

    await withFixtureRepo("subagents", async (root) => {
      const { events } = await runScripted(
        root,
        prompt,
        [
          script(prompt, [
            ...toolCall(0, "call_delegate", "delegate_subagent", {
              parallel: true,
              tasks: [
                { title: "Writer A", prompt: first },
                { title: "Writer B", prompt: second },
              ],
            }),
            completed("tool_use"),
          ]),
          script(first, [
            ...toolCall(0, "call_a", "write_file", { path: "src/shared.txt", content: "A\n" }),
            completed("tool_use"),
          ]),
          script(first, finalText("Wrote A.")),
          script(second, [
            ...toolCall(0, "call_b", "write_file", { path: "src/shared.txt", content: "B\n" }),
            completed("tool_use"),
          ]),
          script(second, finalText("Wrote B.")),
          script(prompt, finalText("Both writers finished.")),
        ],
        { limits: { ...AGENT_LOOP_DEFAULTS, subagentConcurrency: 2 } },
      );

      const contents = await readFile(path.join(root, "src", "shared.txt"), "utf8");
      expect(["A\n", "B\n"]).toContain(contents);

      const completions = events.filter((event) => event.type === "subagent_completed");
      expect(completions).toHaveLength(2);
      expect(completions.every((event) => event.status === "completed")).toBe(true);
    });
  });

  test("reject policy refuses a concurrent write instead of queueing it", async () => {
    const locks = new PathLockManager("reject");
    const release = await locks.acquire(["src/a.txt"]);

    await expect(locks.acquire(["src/a.txt"])).rejects.toMatchObject({ code: "file_locked" });

    release();
    const releaseAgain = await locks.acquire(["src/a.txt"]);
    releaseAgain();
  });

  test("serialize policy queues a second writer until the first releases", async () => {
    const locks = new PathLockManager("serialize");
    const order: string[] = [];

    const releaseFirst = await locks.acquire(["src/b.txt"]);
    const second = locks.acquire(["src/b.txt"]).then((release) => {
      order.push("second acquired");
      release();
    });

    order.push("first holds lock");
    releaseFirst();
    await second;

    expect(order).toEqual(["first holds lock", "second acquired"]);
  });
});
