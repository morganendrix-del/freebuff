import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

import { z } from "zod";

const CONFIG_FILE = "config.json";
const DEFAULT_PLATFORM_URL = "http://127.0.0.1:8788";

const CliConfigSchema = z.object({
  platformUrl: z.string().min(1),
  token: z.string().min(1).optional(),
  userId: z.string().min(1).optional(),
  email: z.string().min(1).optional(),
  defaultProjectId: z.string().min(1).optional(),
});

export type CliConfig = z.infer<typeof CliConfigSchema>;

export interface ConfigStoreOptions {
  readonly directory?: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
}

/** Resolves the per-user config directory: `$FREEBUFF_HOME` or `~/.freebuff`. */
export function resolveConfigDirectory(
  env: Readonly<Record<string, string | undefined>> = process.env,
): string {
  const override = env.FREEBUFF_HOME;
  if (override !== undefined && override.trim() !== "") return path.resolve(override);
  return path.join(homedir(), ".freebuff");
}

export function defaultPlatformUrl(
  env: Readonly<Record<string, string | undefined>> = process.env,
): string {
  const override = env.FREEBUFF_PLATFORM_URL;
  return override !== undefined && override.trim() !== "" ? override : DEFAULT_PLATFORM_URL;
}

/**
 * Token storage for the CLI. Writes are atomic (temp file + rename) so a crash cannot leave a truncated
 * config behind, and the file is created with owner-only permissions.
 */
export class ConfigStore {
  readonly directory: string;
  private cached: CliConfig | undefined;

  constructor(options: ConfigStoreOptions = {}) {
    this.directory = path.resolve(
      options.directory ?? resolveConfigDirectory(options.env ?? process.env),
    );
  }

  get filePath(): string {
    return path.join(this.directory, CONFIG_FILE);
  }

  read(): CliConfig {
    if (this.cached !== undefined) return this.cached;

    let raw: string;
    try {
      raw = readFileSync(this.filePath, "utf8");
    } catch {
      this.cached = { platformUrl: defaultPlatformUrl() };
      return this.cached;
    }

    const parsed = CliConfigSchema.safeParse(JSON.parse(raw) as unknown);
    if (!parsed.success) {
      throw new Error(`Invalid config file at ${this.filePath}. Delete it and sign in again.`);
    }
    this.cached = parsed.data;
    return this.cached;
  }

  write(patch: Partial<CliConfig>): CliConfig {
    const next: CliConfig = { ...this.read(), ...patch };
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    const temporary = `${this.filePath}.${String(process.pid)}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
    renameSync(temporary, this.filePath);
    this.cached = next;
    return next;
  }

  clear(): void {
    this.write({ token: undefined, userId: undefined, email: undefined });
  }

  requireToken(): string {
    const config = this.read();
    if (config.token === undefined) {
      throw new Error("Not signed in. Run `freebuff login <email>` first.");
    }
    return config.token;
  }
}
