import type { StackDetection } from "@freebuff/shared";

export interface StackFiles {
  exists(path: string): Promise<boolean>;
  read(path: string): Promise<string>;
}

interface PackageJson {
  readonly scripts?: Record<string, unknown>;
  readonly packageManager?: string;
}

function parsePackageJson(content: string): PackageJson {
  try {
    const parsed: unknown = JSON.parse(content);
    if (typeof parsed !== "object" || parsed === null) return {};
    const candidate = parsed as { scripts?: unknown; packageManager?: unknown };
    const scripts: Record<string, unknown> = {};
    if (typeof candidate.scripts === "object" && candidate.scripts !== null) {
      for (const [key, value] of Object.entries(candidate.scripts)) {
        if (typeof value === "string") scripts[key] = value;
      }
    }
    return {
      scripts,
      ...(typeof candidate.packageManager === "string"
        ? { packageManager: candidate.packageManager }
        : {}),
    };
  } catch {
    return {};
  }
}

function scriptOf(scripts: Record<string, unknown>, name: string): string | undefined {
  const value = scripts[name];
  return typeof value === "string" ? value : undefined;
}

/** Reads an explicit `--port` from a dev script rather than guessing a framework default. */
export function portFromCommand(command: string | undefined): number | undefined {
  if (command === undefined) return undefined;
  const match = /(?:--port[=\s]+|-p\s+)(\d{2,5})\b/.exec(command);
  if (match?.[1] === undefined) return undefined;
  const port = Number.parseInt(match[1], 10);
  return Number.isInteger(port) && port > 0 && port <= 65_535 ? port : undefined;
}

const LOCKFILES: readonly { file: string; manager: "bun" | "npm" | "pnpm" | "yarn" }[] = [
  { file: "bun.lock", manager: "bun" },
  { file: "bun.lockb", manager: "bun" },
  { file: "pnpm-lock.yaml", manager: "pnpm" },
  { file: "yarn.lock", manager: "yarn" },
  { file: "package-lock.json", manager: "npm" },
];

/**
 * Detects the stack from the cloned tree so install and dev commands are derived from the repository
 * rather than configured per sandbox. Unknown projects still produce a sandbox; the caller decides
 * whether it can be previewed.
 */
export async function detectStack(files: StackFiles): Promise<StackDetection> {
  if (await files.exists("package.json")) {
    const manifest = parsePackageJson(await files.read("package.json"));
    const manager = await detectJavaScriptManager(files, manifest);

    const devCommand =
      scriptOf(manifest.scripts ?? {}, "dev") ??
      scriptOf(manifest.scripts ?? {}, "start") ??
      scriptOf(manifest.scripts ?? {}, "preview");
    const previewPort = portFromCommand(devCommand);

    return {
      stack: manager === "bun" ? "bun" : "node",
      packageManager: manager,
      installCommand: manager === "npm" ? "npm install --no-audit --no-fund" : `${manager} install`,
      ...(devCommand === undefined ? {} : { devCommand }),
      ...(previewPort === undefined ? {} : { previewPort }),
    };
  }

  if (await files.exists("go.mod")) {
    return {
      stack: "go",
      packageManager: "go",
      installCommand: "go mod download",
      devCommand: "go run .",
    };
  }

  if (await files.exists("Cargo.toml")) {
    return {
      stack: "rust",
      packageManager: "cargo",
      installCommand: "cargo fetch",
      devCommand: "cargo run",
    };
  }

  if (await files.exists("pyproject.toml")) {
    return {
      stack: "python",
      packageManager: "poetry",
      installCommand: "python -m pip install poetry && poetry install",
    };
  }

  if (await files.exists("requirements.txt")) {
    return {
      stack: "python",
      packageManager: "pip",
      installCommand: "python -m pip install -r requirements.txt",
    };
  }

  return { stack: "unknown" };
}

async function detectJavaScriptManager(
  files: StackFiles,
  manifest: PackageJson,
): Promise<"bun" | "npm" | "pnpm" | "yarn"> {
  for (const lockfile of LOCKFILES) {
    if (await files.exists(lockfile.file)) return lockfile.manager;
  }
  const declared = manifest.packageManager?.split("@")[0];
  if (declared === "bun" || declared === "npm" || declared === "pnpm" || declared === "yarn") {
    return declared;
  }
  return "npm";
}
