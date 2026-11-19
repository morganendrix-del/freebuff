import type { RepoSource } from "@freebuff/shared";

import { SandboxError } from "./errors";
import type { SandboxInstance } from "./provider";

const OWNER_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const NAME_PATTERN = /^[A-Za-z0-9._-]{1,100}$/;
const BRANCH_PATTERN = /^[A-Za-z0-9._/-]{1,200}$/;
const SAFE_CLONE_URL = /^(?:https|file|git):\/\/[^\s'"`$;&|<>(){}]+$/;

const CLONE_TIMEOUT_MS = 120_000;

export function cloneUrlFor(repo: RepoSource): string {
  if (!OWNER_PATTERN.test(repo.owner)) {
    throw new SandboxError("invalid_input", `Invalid repository owner: ${repo.owner}`);
  }
  if (!NAME_PATTERN.test(repo.name) || repo.name === "." || repo.name === "..") {
    throw new SandboxError("invalid_input", `Invalid repository name: ${repo.name}`);
  }
  const suffix = repo.name.endsWith(".git") ? "" : ".git";
  return `https://github.com/${repo.owner}/${repo.name}${suffix}`;
}

export interface CloneOptions {
  readonly url: string;
  readonly branch?: string;
  /** Installation token. Passed through the environment, never through argv. */
  readonly token?: string;
}

export interface CloneCommand {
  readonly command: string;
  readonly env: Readonly<Record<string, string>>;
}

/**
 * Builds the clone invocation.
 *
 * The token is supplied with git's `http.extraHeader` through `GIT_CONFIG_*` environment variables
 * instead of the URL or argv, so it does not appear in the process list, shell history or logs. The
 * URL is validated against a strict allowlist pattern before it reaches the shell.
 */
export function buildCloneCommand(options: CloneOptions): CloneCommand {
  if (!SAFE_CLONE_URL.test(options.url)) {
    throw new SandboxError("invalid_input", `Unsupported clone URL: ${options.url}`);
  }
  if (options.branch !== undefined && !BRANCH_PATTERN.test(options.branch)) {
    throw new SandboxError("invalid_input", `Invalid branch name: ${options.branch}`);
  }
  if (options.token !== undefined && /[^\x21-\x7e]/.test(options.token)) {
    throw new SandboxError("invalid_input", "Installation token contains unsupported characters.");
  }

  const branch = options.branch === undefined ? "" : `--branch '${options.branch}' `;
  const command = `git clone --depth 1 --single-branch ${branch}-- '${options.url}' .`;

  const env: Record<string, string> = {
    GIT_TERMINAL_PROMPT: "0",
    GIT_ASKPASS: "/bin/true",
  };
  if (options.token !== undefined) {
    env.GIT_CONFIG_COUNT = "1";
    env.GIT_CONFIG_KEY_0 = "http.extraHeader";
    env.GIT_CONFIG_VALUE_0 = `Authorization: Bearer ${options.token}`;
  }

  return { command, env };
}

export interface CloneRepositoryOptions extends CloneOptions {
  readonly timeoutMs?: number;
}

/** Clones into the (empty) sandbox workspace root and reports a usable failure if git fails. */
export async function cloneRepository(
  instance: SandboxInstance,
  options: CloneRepositoryOptions,
): Promise<void> {
  const { command, env } = buildCloneCommand(options);
  const result = await instance.exec({
    command,
    timeoutMs: options.timeoutMs ?? CLONE_TIMEOUT_MS,
    env,
  });

  if (result.exitCode !== 0) {
    const detail = result.stderr.trim().split(/\r?\n/).slice(-3).join(" ");
    throw new SandboxError(
      "invalid_input",
      `git clone failed (exit ${String(result.exitCode)}): ${detail === "" ? "no output" : detail}`,
    );
  }
}
