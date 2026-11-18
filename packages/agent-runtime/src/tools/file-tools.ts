import { MAX_TOOL_OUTPUT_CHARS, PlatformError, TOOL_NAMES } from "@freebuff/shared";
import type { JsonObject, ToolOutcome } from "@freebuff/shared";

import type { ToolBinding } from "../registry";
import type { WorkspaceHost } from "./workspace";
import { optionalBoolean, optionalNumber, requireArray, requireString } from "./input";

const READ_LIMIT = 2_000;

function clampContent(content: string): { content: string; truncated: boolean } {
  if (content.length <= MAX_TOOL_OUTPUT_CHARS) return { content, truncated: false };
  return {
    content: `${content.slice(0, MAX_TOOL_OUTPUT_CHARS)}\n…[truncated ${String(
      content.length - MAX_TOOL_OUTPUT_CHARS,
    )} characters]`,
    truncated: true,
  };
}

export function createReadFileTool(host: WorkspaceHost): ToolBinding {
  return {
    definition: {
      name: TOOL_NAMES.readFile,
      description: "Read a UTF-8 file from the project. Returns numbered lines.",
      category: "filesystem",
      risk: "read",
      timeoutMs: 10_000,
      idempotent: true,
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string", description: "Project-relative path" },
          offset: { type: "integer", minimum: 1, description: "1-based first line" },
          limit: { type: "integer", minimum: 1, maximum: 5_000 },
        },
        required: ["path"],
        additionalProperties: false,
      },
    },
    async execute(input): Promise<ToolOutcome> {
      const startedAt = performance.now();
      const relativePath = requireString(input, "path");
      const offset = optionalNumber(input, "offset") ?? 1;
      const limit = optionalNumber(input, "limit") ?? READ_LIMIT;

      const contents = await host.readFile(relativePath);
      const lines = contents.split(/\r?\n/);
      const from = Math.max(0, Math.floor(offset) - 1);
      const selected = lines.slice(from, from + Math.floor(limit));
      const body = selected.map((line, index) => `${String(from + index + 1)}\t${line}`).join("\n");
      const clamped = clampContent(body);

      const output: JsonObject = {
        path: relativePath,
        content: clamped.content,
        totalLines: lines.length,
        truncated: clamped.truncated || from + selected.length < lines.length,
      };

      return {
        ok: true,
        summary: `Read ${relativePath} (${String(selected.length)} of ${String(lines.length)} lines)`,
        output,
        durationMs: performance.now() - startedAt,
      };
    },
  };
}

export function createWriteFileTool(host: WorkspaceHost): ToolBinding {
  return {
    definition: {
      name: TOOL_NAMES.writeFile,
      description: "Create or overwrite a project file with the given contents.",
      category: "filesystem",
      risk: "write",
      timeoutMs: 15_000,
      idempotent: false,
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string", description: "Project-relative path" },
          content: { type: "string" },
        },
        required: ["path", "content"],
        additionalProperties: false,
      },
    },
    async execute(input): Promise<ToolOutcome> {
      const startedAt = performance.now();
      const relativePath = requireString(input, "path");
      const content = input.content;
      if (typeof content !== "string") {
        throw new PlatformError("invalid_input", 'Argument "content" must be a string.');
      }

      const release = await host.locks.acquire([relativePath]);
      try {
        await host.writeFile(relativePath, content);
      } finally {
        release();
      }

      return {
        ok: true,
        summary: `Wrote ${relativePath} (${String(content.length)} characters)`,
        output: { path: relativePath, bytes: content.length },
        durationMs: performance.now() - startedAt,
      };
    },
  };
}

export function createEditFileTool(host: WorkspaceHost): ToolBinding {
  return {
    definition: {
      name: TOOL_NAMES.editFile,
      description:
        "Replace an exact string in one file. The old string must appear exactly once unless replaceAll is true.",
      category: "filesystem",
      risk: "write",
      timeoutMs: 15_000,
      idempotent: false,
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string" },
          oldString: { type: "string" },
          newString: { type: "string" },
          replaceAll: { type: "boolean" },
        },
        required: ["path", "oldString", "newString"],
        additionalProperties: false,
      },
    },
    async execute(input): Promise<ToolOutcome> {
      const startedAt = performance.now();
      const relativePath = requireString(input, "path");
      const oldString = requireString(input, "oldString");
      const newString = input.newString;
      if (typeof newString !== "string") {
        throw new PlatformError("invalid_input", 'Argument "newString" must be a string.');
      }
      const replaceAll = optionalBoolean(input, "replaceAll") ?? false;

      const release = await host.locks.acquire([relativePath]);
      try {
        const original = await host.readFile(relativePath);
        const occurrences = original.split(oldString).length - 1;
        if (occurrences === 0) {
          throw new PlatformError("not_found", `"oldString" was not found in ${relativePath}.`);
        }
        if (occurrences > 1 && !replaceAll) {
          throw new PlatformError(
            "invalid_input",
            `"oldString" appears ${String(occurrences)} times in ${relativePath}; provide more context or set replaceAll.`,
          );
        }

        const updated = replaceAll
          ? original.split(oldString).join(newString)
          : original.replace(oldString, newString);
        await host.writeFile(relativePath, updated);

        return {
          ok: true,
          summary: `Edited ${relativePath} (${String(occurrences)} replacement${
            occurrences === 1 ? "" : "s"
          })`,
          output: { path: relativePath, replacements: occurrences },
          durationMs: performance.now() - startedAt,
        };
      } finally {
        release();
      }
    },
  };
}

export function createMultiEditTool(host: WorkspaceHost): ToolBinding {
  return {
    definition: {
      name: TOOL_NAMES.multiEdit,
      description:
        "Apply several exact-string edits across one or more files as a single coordinated change.",
      category: "filesystem",
      risk: "write",
      timeoutMs: 30_000,
      idempotent: false,
      inputSchema: {
        type: "object",
        properties: {
          edits: {
            type: "array",
            minLength: 1,
            items: {
              type: "object",
              properties: {
                path: { type: "string" },
                oldString: { type: "string" },
                newString: { type: "string" },
              },
              required: ["path", "oldString", "newString"],
            },
          },
        },
        required: ["edits"],
        additionalProperties: false,
      },
    },
    async execute(input): Promise<ToolOutcome> {
      const startedAt = performance.now();
      const edits = requireArray(input, "edits").map((edit) => ({
        path: requireString(edit, "path"),
        oldString: requireString(edit, "oldString"),
        newString: (() => {
          const value = edit.newString;
          if (typeof value !== "string") {
            throw new PlatformError("invalid_input", 'Argument "newString" must be a string.');
          }
          return value;
        })(),
      }));

      const release = await host.locks.acquire(edits.map((edit) => edit.path));
      const originals = new Map<string, string>();

      try {
        for (const edit of edits) {
          if (!originals.has(edit.path)) originals.set(edit.path, await host.readFile(edit.path));
        }

        const staged = new Map(originals);
        for (const edit of edits) {
          const current = staged.get(edit.path) ?? "";
          if (!current.includes(edit.oldString)) {
            throw new PlatformError(
              "invalid_input",
              `"oldString" was not found in ${edit.path} while applying a multi-file edit.`,
            );
          }
          staged.set(edit.path, current.replace(edit.oldString, edit.newString));
        }

        const written: string[] = [];
        try {
          for (const [file, content] of staged) {
            await host.writeFile(file, content);
            written.push(file);
          }
        } catch (error) {
          for (const file of written) {
            await host.writeFile(file, originals.get(file) ?? "").catch(() => undefined);
          }
          throw error;
        }

        return {
          ok: true,
          summary: `Applied ${String(edits.length)} edits across ${String(staged.size)} file(s)`,
          output: { files: [...staged.keys()], edits: edits.length },
          durationMs: performance.now() - startedAt,
        };
      } finally {
        release();
      }
    },
  };
}
