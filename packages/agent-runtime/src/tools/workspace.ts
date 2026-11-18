import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import type { CodeMapService } from "@freebuff/code-map";
import { PlatformError } from "@freebuff/shared";

import { PathLockManager } from "../locking";

const MAX_FILE_BYTES = 512 * 1024;
const SEARCHABLE_EXTENSIONS = new Set([
  ".css",
  ".go",
  ".html",
  ".js",
  ".json",
  ".jsx",
  ".md",
  ".mjs",
  ".prisma",
  ".py",
  ".rs",
  ".sql",
  ".toml",
  ".ts",
  ".tsx",
  ".txt",
  ".yaml",
  ".yml",
]);
const IGNORED_DIRECTORIES = new Set([".git", ".next", "dist", "build", "coverage", "node_modules"]);

export interface SearchHit {
  readonly file: string;
  readonly line: number;
  readonly text: string;
}

export interface CommandResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly durationMs: number;
}

/** Shell port. The only production implementation is the sandbox orchestrator (Phase 3). */
export interface CommandExecutor {
  execute(
    command: string,
    options: { readonly cwd: string; readonly timeoutMs: number; readonly signal: AbortSignal },
  ): Promise<CommandResult>;
}

export interface FetchResult {
  readonly status: number;
  readonly body: string;
}

export interface WorkspaceHost {
  readonly root: string;
  readonly locks: PathLockManager;
  readonly commandExecutor: CommandExecutor | undefined;
  readonly fetchUrl: ((url: string, signal: AbortSignal) => Promise<FetchResult>) | undefined;
  readonly codeMap: CodeMapService | undefined;
  readFile(relativePath: string): Promise<string>;
  writeFile(relativePath: string, content: string): Promise<void>;
  listFiles(limit: number): Promise<string[]>;
  search(pattern: string, options: { glob?: string; maxResults: number }): Promise<SearchHit[]>;
}

export interface WorkspaceOptions {
  readonly root: string;
  readonly locks?: PathLockManager;
  readonly commandExecutor?: CommandExecutor;
  readonly fetchUrl?: (url: string, signal: AbortSignal) => Promise<FetchResult>;
  readonly codeMap?: CodeMapService;
}

/** Resolves a workspace-relative path, refusing escapes (including symlink-free `..` tricks). */
export function resolveInsideRoot(root: string, relativePath: string): string {
  const absoluteRoot = path.resolve(root);
  const resolved = path.resolve(absoluteRoot, relativePath);
  if (resolved !== absoluteRoot && !resolved.startsWith(`${absoluteRoot}${path.sep}`)) {
    throw new PlatformError("permission_denied", `Path escapes the workspace: ${relativePath}`);
  }
  return resolved;
}

export function createFileSystemWorkspace(options: WorkspaceOptions): WorkspaceHost {
  const root = path.resolve(options.root);
  const locks = options.locks ?? new PathLockManager();

  const listFiles = async (limit: number): Promise<string[]> => {
    const found: string[] = [];

    const walk = async (directory: string): Promise<void> => {
      if (found.length >= limit) return;
      const entries = await readdir(directory, { withFileTypes: true });
      entries.sort((left, right) => left.name.localeCompare(right.name));

      for (const entry of entries) {
        if (found.length >= limit) return;
        if (entry.isSymbolicLink()) continue;
        const absolute = path.join(directory, entry.name);
        if (entry.isDirectory()) {
          if (IGNORED_DIRECTORIES.has(entry.name)) continue;
          await walk(absolute);
          continue;
        }
        found.push(path.relative(root, absolute).split(path.sep).join("/"));
      }
    };

    await walk(root);
    return found;
  };

  return {
    root,
    locks,
    commandExecutor: options.commandExecutor,
    fetchUrl: options.fetchUrl,
    codeMap: options.codeMap,

    async readFile(relativePath) {
      const absolute = resolveInsideRoot(root, relativePath);
      const info = await stat(absolute).catch(() => undefined);
      if (!info?.isFile()) throw new PlatformError("not_found", `File not found: ${relativePath}`);
      if (info.size > MAX_FILE_BYTES) {
        throw new PlatformError("output_too_large", `File is too large to read: ${relativePath}`);
      }
      return readFile(absolute, "utf8");
    },

    async writeFile(relativePath, content) {
      const absolute = resolveInsideRoot(root, relativePath);
      await mkdir(path.dirname(absolute), { recursive: true });
      await writeFile(absolute, content, "utf8");
    },

    listFiles,

    async search(pattern, searchOptions) {
      let matcher: RegExp;
      try {
        matcher = new RegExp(pattern, "i");
      } catch (error) {
        throw new PlatformError("invalid_input", `Invalid search pattern: ${pattern}`, {
          cause: error,
        });
      }

      const files = await listFiles(5_000);
      const hits: SearchHit[] = [];

      for (const file of files) {
        if (hits.length >= searchOptions.maxResults) break;
        if (!SEARCHABLE_EXTENSIONS.has(path.extname(file))) continue;
        if (searchOptions.glob !== undefined && !file.includes(searchOptions.glob)) continue;

        const contents = await readFile(path.join(root, file), "utf8").catch(() => "");
        const lines = contents.split(/\r?\n/);
        for (let index = 0; index < lines.length; index += 1) {
          if (hits.length >= searchOptions.maxResults) break;
          const line = lines[index] ?? "";
          if (matcher.test(line)) hits.push({ file, line: index + 1, text: line.trim() });
        }
      }

      return hits;
    },
  };
}
