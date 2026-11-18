import type { ToolRegistry } from "../registry";
import { ToolRegistry as Registry } from "../registry";
import type { ToolBinding } from "../registry";
import {
  createEditFileTool,
  createMultiEditTool,
  createReadFileTool,
  createWriteFileTool,
} from "./file-tools";
import {
  createCodeMapTool,
  createDelegateTool,
  createRunCommandTool,
  createSearchTool,
  createWebFetchTool,
} from "./other-tools";
import type { WorkspaceHost } from "./workspace";

export * from "./file-tools";
export * from "./input";
export * from "./other-tools";
export * from "./workspace";

export function createDefaultTools(host: WorkspaceHost): ToolBinding[] {
  return [
    createReadFileTool(host),
    createWriteFileTool(host),
    createEditFileTool(host),
    createMultiEditTool(host),
    createSearchTool(host),
    createRunCommandTool(host),
    createWebFetchTool(host),
    createCodeMapTool(host),
    createDelegateTool(),
  ];
}

export function createToolRegistry(host: WorkspaceHost): ToolRegistry {
  const registry = new Registry();
  for (const binding of createDefaultTools(host)) registry.register(binding);
  return registry;
}
