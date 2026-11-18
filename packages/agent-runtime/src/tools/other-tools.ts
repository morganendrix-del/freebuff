import { PlatformError, TOOL_NAMES } from "@freebuff/shared";
import type { JsonObject, ToolOutcome } from "@freebuff/shared";

import type { ToolBinding } from "../registry";
import {
  optionalBoolean,
  optionalNumber,
  optionalString,
  requireArray,
  requireString,
} from "./input";
import type { WorkspaceHost } from "./workspace";

const MAX_SEARCH_RESULTS = 200;

export function createSearchTool(host: WorkspaceHost): ToolBinding {
  return {
    definition: {
      name: TOOL_NAMES.search,
      description: "Search the project with a regular expression; returns matching file/line hits.",
      category: "search",
      risk: "read",
      timeoutMs: 20_000,
      idempotent: true,
      inputSchema: {
        type: "object",
        properties: {
          pattern: { type: "string" },
          glob: { type: "string", description: "Substring the file path must contain" },
          maxResults: { type: "integer", minimum: 1, maximum: MAX_SEARCH_RESULTS },
        },
        required: ["pattern"],
        additionalProperties: false,
      },
    },
    async execute(input): Promise<ToolOutcome> {
      const startedAt = performance.now();
      const pattern = requireString(input, "pattern");
      const glob = optionalString(input, "glob");
      const maxResults = Math.min(optionalNumber(input, "maxResults") ?? 50, MAX_SEARCH_RESULTS);

      const hits = await host.search(pattern, {
        maxResults,
        ...(glob === undefined ? {} : { glob }),
      });

      return {
        ok: true,
        summary: `Found ${String(hits.length)} match(es) for /${pattern}/`,
        output: {
          hits: hits.map((hit) => ({ file: hit.file, line: hit.line, text: hit.text })),
        },
        durationMs: performance.now() - startedAt,
      };
    },
  };
}

export function createRunCommandTool(host: WorkspaceHost): ToolBinding {
  return {
    definition: {
      name: TOOL_NAMES.runCommand,
      description:
        "Run a shell command inside the sandboxed workspace and return stdout, stderr and exit code.",
      category: "shell",
      risk: "execute",
      timeoutMs: 120_000,
      idempotent: false,
      inputSchema: {
        type: "object",
        properties: {
          command: { type: "string" },
          timeoutMs: { type: "integer", minimum: 1_000, maximum: 120_000 },
        },
        required: ["command"],
        additionalProperties: false,
      },
    },
    async execute(input, context): Promise<ToolOutcome> {
      const startedAt = performance.now();
      const command = requireString(input, "command");
      const executor = host.commandExecutor;
      if (!executor) {
        throw new PlatformError(
          "permission_denied",
          "No sandbox executor is attached; shell execution is unavailable in this environment.",
        );
      }

      const allowlist = context.permissions.shellCommandAllowlist;
      if (allowlist !== undefined && allowlist.length > 0) {
        const allowed = allowlist.some((prefix) => command.trimStart().startsWith(prefix));
        if (!allowed) {
          throw new PlatformError(
            "permission_denied",
            `Command is not on the allowlist: ${command.split(/\s+/)[0] ?? command}`,
          );
        }
      }

      const result = await executor.execute(command, {
        cwd: host.root,
        timeoutMs: optionalNumber(input, "timeoutMs") ?? 60_000,
        signal: context.signal,
      });

      const durationMs = performance.now() - startedAt;
      const output: JsonObject = {
        exitCode: result.exitCode,
        stdout: result.stdout.slice(0, 20_000),
        stderr: result.stderr.slice(0, 20_000),
      };

      if (result.exitCode === 0) {
        return { ok: true, summary: `Command succeeded: ${command}`, output, durationMs };
      }
      return {
        ok: false,
        summary: `Command failed with exit code ${String(result.exitCode)}`,
        error: {
          code: "execution_failed",
          message: `Command exited with code ${String(result.exitCode)}`,
          retryable: false,
        },
        durationMs,
      };
    },
  };
}

export function createWebFetchTool(host: WorkspaceHost): ToolBinding {
  return {
    definition: {
      name: TOOL_NAMES.webFetch,
      description: "Fetch an http(s) URL and return its text body (truncated).",
      category: "network",
      risk: "network",
      timeoutMs: 30_000,
      idempotent: true,
      inputSchema: {
        type: "object",
        properties: { url: { type: "string" } },
        required: ["url"],
        additionalProperties: false,
      },
    },
    async execute(input, context): Promise<ToolOutcome> {
      const startedAt = performance.now();
      const url = requireString(input, "url");
      if (!/^https?:\/\//i.test(url)) {
        throw new PlatformError("invalid_input", "Only http(s) URLs can be fetched.");
      }

      const fetchUrl = host.fetchUrl;
      if (!fetchUrl) {
        throw new PlatformError(
          "permission_denied",
          "Network access is not configured for this workspace.",
        );
      }

      const result = await fetchUrl(url, context.signal);
      const durationMs = performance.now() - startedAt;
      const output: JsonObject = { status: result.status, body: result.body.slice(0, 20_000) };

      if (result.status >= 200 && result.status < 300) {
        return {
          ok: true,
          summary: `Fetched ${url} (HTTP ${String(result.status)})`,
          output,
          durationMs,
        };
      }
      return {
        ok: false,
        summary: `Fetch failed for ${url} (HTTP ${String(result.status)})`,
        error: {
          code: "execution_failed",
          message: `HTTP ${String(result.status)}`,
          retryable: true,
        },
        durationMs,
      };
    },
  };
}

export function createCodeMapTool(host: WorkspaceHost): ToolBinding {
  return {
    definition: {
      name: TOOL_NAMES.codeMapQuery,
      description:
        "Query the repository symbol graph: list files, outline a file, find symbols, or find references to a symbol.",
      category: "code_intelligence",
      risk: "read",
      timeoutMs: 15_000,
      idempotent: true,
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", enum: ["files", "outline", "references", "symbols"] },
          name: { type: "string" },
          file: { type: "string" },
        },
        required: ["query"],
        additionalProperties: false,
      },
    },
    execute(input): Promise<ToolOutcome> {
      const startedAt = performance.now();
      const service = host.codeMap;
      if (!service) {
        throw new PlatformError("not_found", "No code map is indexed for this workspace.");
      }

      const kind = requireString(input, "query");
      const name = optionalString(input, "name");
      const file = optionalString(input, "file");

      const result =
        kind === "files"
          ? service.query({ kind: "files" })
          : kind === "outline"
            ? service.query({ kind: "outline", file: requireString(input, "file") })
            : kind === "references"
              ? service.query({ kind: "references", name: requireString(input, "name") })
              : service.query({
                  kind: "symbols",
                  ...(name === undefined ? {} : { name }),
                  ...(file === undefined ? {} : { file }),
                });

      return Promise.resolve({
        ok: true,
        summary: `${kind}: ${String(result.symbols.length)} symbol(s), ${String(
          result.references.length,
        )} reference(s)`,
        output: {
          files: [...result.files],
          symbols: result.symbols.map((symbol) => ({
            name: symbol.name,
            kind: symbol.kind,
            file: symbol.file,
            line: symbol.line,
            exported: symbol.exported,
          })),
          references: result.references.map((reference) => ({
            name: reference.name,
            file: reference.file,
            line: reference.line,
          })),
          truncated: result.truncated,
        },
        durationMs: performance.now() - startedAt,
      });
    },
  };
}

export function createDelegateTool(): ToolBinding {
  return {
    definition: {
      name: TOOL_NAMES.delegateSubagent,
      description:
        "Delegate independent tasks to subagents. Parallel subagents share one workspace; overlapping file writes are serialised.",
      category: "subagent",
      risk: "read",
      timeoutMs: 300_000,
      idempotent: false,
      inputSchema: {
        type: "object",
        properties: {
          tasks: {
            type: "array",
            items: {
              type: "object",
              properties: { title: { type: "string" }, prompt: { type: "string" } },
              required: ["title", "prompt"],
            },
          },
          parallel: { type: "boolean" },
        },
        required: ["tasks"],
        additionalProperties: false,
      },
    },
    // The loop intercepts this tool; reaching the registry means nested delegation is disabled.
    execute: () =>
      Promise.reject(
        new PlatformError(
          "permission_denied",
          "Subagent delegation is not available in this run (nesting limit reached).",
        ),
      ),
  };
}

export interface DelegationTask {
  readonly title: string;
  readonly prompt: string;
}

export function parseDelegationTasks(input: JsonObject): {
  readonly tasks: readonly DelegationTask[];
  readonly parallel: boolean;
} {
  const tasks = requireArray(input, "tasks").map((task) => ({
    title: requireString(task, "title"),
    prompt: requireString(task, "prompt"),
  }));

  return { tasks, parallel: optionalBoolean(input, "parallel") ?? false };
}
