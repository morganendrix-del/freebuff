import path from "node:path";

import type { PlatformClient } from "@freebuff/sdk";
import type { ProjectRef } from "@freebuff/shared";

export interface ResolveProjectOptions {
  readonly client: PlatformClient;
  readonly rootPath: string;
  readonly name?: string;
}

/**
 * Finds (or registers) the project for a directory. The picker uses this so the same checkout always
 * maps to one project id, and chat history stays attached to it.
 */
export async function resolveProject(options: ResolveProjectOptions): Promise<ProjectRef> {
  const rootPath = path.resolve(options.rootPath);
  const projects = await options.client.projects.list();
  const existing = projects.find((project) => path.resolve(project.rootPath) === rootPath);
  if (existing !== undefined) return existing;

  return options.client.projects.register({
    name: options.name ?? (path.basename(rootPath) || "workspace"),
    rootPath,
  });
}

export async function listProjects(client: PlatformClient): Promise<readonly ProjectRef[]> {
  return client.projects.list();
}
