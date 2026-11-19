import { lstat, mkdir, readFile, readdir, realpath, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import { SandboxError } from "./errors";

const DEFAULT_MAX_FILE_BYTES = 512 * 1024;
const DEFAULT_LIST_LIMIT = 5_000;
const SKIPPED_DIRECTORIES = new Set([".git", "node_modules"]);

export interface WorkspaceOptions {
  readonly maxFileBytes?: number;
}

/**
 * Filesystem jail for one sandbox workspace.
 *
 * Every path crossing the sandbox boundary goes through here: relative-path enforcement, lexical
 * containment, and a realpath check of the nearest existing ancestor so a symlink planted inside the
 * workspace cannot be used to read or overwrite the host. The container/microVM root filesystem is
 * additionally read-only (see `docker.ts`), so this is the second layer, not the only one.
 */
export class WorkspaceJail {
  readonly root: string;
  readonly #maxFileBytes: number;
  #realRoot: string | undefined;

  constructor(root: string, options: WorkspaceOptions = {}) {
    if (!path.isAbsolute(root)) {
      throw new SandboxError("invalid_input", "Workspace root must be an absolute path.");
    }
    this.root = path.resolve(root);
    this.#maxFileBytes = options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
  }

  /** Creates the workspace directory and records its real path for containment checks. */
  async init(): Promise<void> {
    await mkdir(this.root, { recursive: true });
    this.#realRoot = await realpath(this.root);
  }

  /** Lexical resolution: rejects absolute paths and `..` escapes before touching the disk. */
  resolve(relativePath: string): string {
    if (relativePath.includes("\0")) {
      throw new SandboxError("invalid_input", "Path contains a null byte.");
    }
    if (path.isAbsolute(relativePath)) {
      throw new SandboxError(
        "permission_denied",
        `Path must be relative to the workspace: ${relativePath}`,
      );
    }
    const target = path.resolve(this.root, relativePath);
    if (target !== this.root && !target.startsWith(`${this.root}${path.sep}`)) {
      throw new SandboxError("permission_denied", `Path escapes the workspace: ${relativePath}`);
    }
    return target;
  }

  async read(relativePath: string): Promise<string> {
    const absolute = this.resolve(relativePath);
    await this.#assertNoSymlinkEscape(absolute, relativePath);
    const info = await stat(absolute).catch(() => undefined);
    if (info?.isFile() !== true) {
      throw new SandboxError("not_found", `File not found: ${relativePath}`);
    }
    if (info.size > this.#maxFileBytes) {
      throw new SandboxError("output_too_large", `File is too large to read: ${relativePath}`, {});
    }
    return readFile(absolute, "utf8");
  }

  async write(relativePath: string, content: string): Promise<void> {
    if (Buffer.byteLength(content, "utf8") > this.#maxFileBytes) {
      throw new SandboxError(
        "output_too_large",
        `Refusing to write more than the file cap: ${relativePath}`,
        {},
      );
    }
    const absolute = this.resolve(relativePath);
    await this.#assertNoSymlinkEscape(absolute, relativePath);
    await mkdir(path.dirname(absolute), { recursive: true });
    await this.#assertNoSymlinkEscape(path.dirname(absolute), relativePath);
    await writeFile(absolute, content, "utf8");
  }

  async exists(relativePath: string): Promise<boolean> {
    const absolute = this.resolve(relativePath);
    const info = await lstat(absolute).catch(() => undefined);
    return info !== undefined;
  }

  async list(limit = DEFAULT_LIST_LIMIT): Promise<string[]> {
    const found: string[] = [];
    const rootReal = await this.#realRootPath();

    const walk = async (directory: string): Promise<void> => {
      if (found.length >= limit) return;
      const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
      entries.sort((left, right) => left.name.localeCompare(right.name));

      for (const entry of entries) {
        if (found.length >= limit) return;
        if (entry.isSymbolicLink()) continue;
        if (SKIPPED_DIRECTORIES.has(entry.name)) continue;
        const absolute = path.join(directory, entry.name);
        if (entry.isDirectory()) {
          await walk(absolute);
          continue;
        }
        found.push(path.relative(rootReal, absolute).split(path.sep).join("/"));
      }
    };

    await walk(rootReal);
    return found;
  }

  async #realRootPath(): Promise<string> {
    if (this.#realRoot !== undefined) return this.#realRoot;
    this.#realRoot = await realpath(this.root);
    return this.#realRoot;
  }

  async #assertNoSymlinkEscape(absolute: string, relativePath: string): Promise<void> {
    const rootReal = await this.#realRootPath();
    let current = absolute;

    for (;;) {
      const info = await lstat(current).catch(() => undefined);
      if (info !== undefined) {
        const resolved = await realpath(current);
        const inside =
          resolved === rootReal ||
          resolved.startsWith(`${rootReal}${path.sep}`) ||
          // A symlink that resolves to the root itself (e.g. `link -> .`) is still contained.
          resolved === this.root;
        if (!inside) {
          throw new SandboxError(
            "permission_denied",
            `Path resolves outside the workspace: ${relativePath}`,
          );
        }
        return;
      }
      const parent = path.dirname(current);
      if (parent === current) return;
      current = parent;
    }
  }
}
