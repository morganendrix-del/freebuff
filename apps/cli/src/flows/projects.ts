import path from "node:path";

import type { PlatformClient } from "@freebuff/sdk";
import type { ProjectRef } from "@freebuff/shared";

export interface BootstrapOptions {
  readonly client: PlatformClient;
  readonly rootPath: string;
}

export interface WorkspaceBootstrap {
  /** The project for the directory the CLI was started in, when one exists. */
  readonly project?: ProjectRef;
  readonly projects: readonly ProjectRef[];
  /** True when this run created the project for the current directory. */
  readonly registered: boolean;
}

/**
 * Makes the current directory usable for a first-time user: an account with no projects gets one
 * registered for the working directory immediately, while an account with other projects is left to
 * choose (the picker also offers to register this directory).
 */
export async function bootstrapWorkspace(options: BootstrapOptions): Promise<WorkspaceBootstrap> {
  const rootPath = path.resolve(options.rootPath);
  const projects = await options.client.projects.list();
  const existing = projects.find((project) => path.resolve(project.rootPath) === rootPath);
  if (existing !== undefined) return { project: existing, projects, registered: false };
  if (projects.length > 0) return { projects, registered: false };

  const project = await resolveProject({ client: options.client, rootPath });
  return { project, projects: [project], registered: true };
}

/** Registers the current directory on demand, for the picker's "register this directory" entry. */
export async function registerCurrentProject(options: BootstrapOptions): Promise<ProjectRef> {
  return resolveProject({ client: options.client, rootPath: options.rootPath });
}

export interface WorkspaceView {
  readonly phase: "picking_project" | "ready";
  readonly activeProject?: ProjectRef;
  readonly statusLine: string;
}

/**
 * Initial TUI view for a bootstrap result. A fresh account goes straight to chat in the current
 * directory; only a repository with several existing projects asks the user to pick one.
 */
export function planWorkspaceView(bootstrap: WorkspaceBootstrap): WorkspaceView {
  const project = bootstrap.project;
  if (project === undefined) {
    return {
      phase: "picking_project",
      statusLine: `${String(bootstrap.projects.length)} projects available — pick one or register this directory.`,
    };
  }

  return {
    phase: "ready",
    activeProject: project,
    statusLine: bootstrap.registered
      ? `Registered ${project.name} for this directory.`
      : `Working in ${project.name}.`,
  };
}

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
