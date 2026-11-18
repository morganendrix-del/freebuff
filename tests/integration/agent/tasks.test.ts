import { readFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, test } from "vitest";

import { completed, finalText, script, toolCall } from "./scripted-provider";
import { runScripted, withFixtureRepo } from "./harness";

describe("scripted fixture tasks (Phase 1 gate)", () => {
  test("1/5 bugfix: reads the file, edits the defect, reports completion", async () => {
    const prompt = "Fix the off-by-sign bug in src/add.ts";

    await withFixtureRepo("bugfix", async (root) => {
      const { result, events } = await runScripted(root, prompt, [
        script(prompt, [
          ...toolCall(0, "call_read", "read_file", { path: "src/add.ts" }),
          completed("tool_use"),
        ]),
        script(prompt, [
          ...toolCall(0, "call_edit", "edit_file", {
            path: "src/add.ts",
            oldString: "return left - right;",
            newString: "return left + right;",
          }),
          completed("tool_use"),
        ]),
        script(prompt, finalText("Fixed the addition bug.")),
      ]);

      expect(result.status).toBe("completed");
      expect(result.reason).toBe("assistant_finished");
      expect(await readFile(path.join(root, "src", "add.ts"), "utf8")).toContain(
        "return left + right;",
      );
      expect(
        events.some((event) => event.type === "tool_result" && event.toolName === "edit_file"),
      ).toBe(true);
    });
  });

  test("2/5 multifile: coordinated rename across two files", async () => {
    const prompt = "Rename greet to welcome across the project";

    await withFixtureRepo("multifile", async (root) => {
      const { result } = await runScripted(root, prompt, [
        script(prompt, [
          ...toolCall(0, "call_multi", "multi_edit", {
            edits: [
              {
                path: "src/greet.ts",
                oldString: "export function greet(",
                newString: "export function welcome(",
              },
              { path: "src/index.ts", oldString: 'greet("ada")', newString: 'welcome("ada")' },
            ],
          }),
          completed("tool_use"),
        ]),
        script(prompt, finalText("Renamed across both files.")),
      ]);

      expect(result.status).toBe("completed");
      expect(await readFile(path.join(root, "src", "greet.ts"), "utf8")).toContain(
        "export function welcome(",
      );
      expect(await readFile(path.join(root, "src", "index.ts"), "utf8")).toContain(
        'welcome("ada")',
      );
    });
  });

  test("3/5 newfile: creates a file exactly as specified", async () => {
    const prompt = "Add a config module with DEBUG disabled";

    await withFixtureRepo("newfile", async (root) => {
      const contents = "export const DEBUG = false;\n";

      const { result } = await runScripted(root, prompt, [
        script(prompt, [
          ...toolCall(0, "call_write", "write_file", { path: "src/config.ts", content: contents }),
          completed("tool_use"),
        ]),
        script(prompt, finalText("Added src/config.ts.")),
      ]);

      expect(result.status).toBe("completed");
      expect(await readFile(path.join(root, "src", "config.ts"), "utf8")).toBe(contents);
    });
  });

  test("4/5 search: locates a marker then edits it", async () => {
    const prompt = "Resolve the FIXME in the source tree";

    await withFixtureRepo("search", async (root) => {
      const { events } = await runScripted(root, prompt, [
        script(prompt, [
          ...toolCall(0, "call_search", "ripgrep", { pattern: "FIXME" }),
          completed("tool_use"),
        ]),
        script(prompt, [
          ...toolCall(0, "call_edit", "edit_file", {
            path: "src/legacy.ts",
            oldString: "// FIXME: replace this before release",
            newString: "// Resolved: replacement tracked in ISSUE-42",
          }),
          completed("tool_use"),
        ]),
        script(prompt, finalText("Resolved the FIXME.")),
      ]);

      const searchResult = events.find(
        (event) => event.type === "tool_result" && event.toolName === "ripgrep",
      );
      expect(searchResult).toMatchObject({ ok: true });
      expect(await readFile(path.join(root, "src", "legacy.ts"), "utf8")).toContain("Resolved:");
    });
  });

  test("5/5 subagents: parallel delegation edits disjoint files", async () => {
    const prompt = "Rewrite both text files";
    const taskA = "Rewrite src/a.txt to say new a";
    const taskB = "Rewrite src/b.txt to say new b";

    await withFixtureRepo("subagents", async (root) => {
      const { result, events } = await runScripted(root, prompt, [
        script(prompt, [
          ...toolCall(0, "call_delegate", "delegate_subagent", {
            parallel: true,
            tasks: [
              { title: "Rewrite A", prompt: taskA },
              { title: "Rewrite B", prompt: taskB },
            ],
          }),
          completed("tool_use"),
        ]),
        script(taskA, [
          ...toolCall(0, "call_a", "write_file", { path: "src/a.txt", content: "new a\n" }),
          completed("tool_use"),
        ]),
        script(taskA, finalText("Rewrote src/a.txt.")),
        script(taskB, [
          ...toolCall(0, "call_b", "write_file", { path: "src/b.txt", content: "new b\n" }),
          completed("tool_use"),
        ]),
        script(taskB, finalText("Rewrote src/b.txt.")),
        script(prompt, finalText("Both files rewritten.")),
      ]);

      expect(result.status).toBe("completed");
      expect(await readFile(path.join(root, "src", "a.txt"), "utf8")).toBe("new a\n");
      expect(await readFile(path.join(root, "src", "b.txt"), "utf8")).toBe("new b\n");

      const completions = events.filter((event) => event.type === "subagent_completed");
      expect(completions).toHaveLength(2);
      expect(completions.every((event) => event.status === "completed")).toBe(true);
    });
  });
});
