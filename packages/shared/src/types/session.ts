import type { AgentMessage } from "./agent";
import type { Id } from "./ids";
import type { AgentTier } from "./tier";

/** The four interoperable surfaces share one runtime and one context model. */
export type Surface = "cli" | "cloud" | "desktop" | "web";

export type SessionStatus = "active" | "archived";

export interface ProjectRef {
  readonly id: Id<"project">;
  readonly name: string;
  readonly rootPath: string;
  readonly gitRemote?: string;
  readonly defaultBranch?: string;
}

export interface Session {
  readonly id: Id<"session">;
  readonly userId: Id<"user">;
  readonly project: ProjectRef;
  readonly surface: Surface;
  readonly title: string;
  readonly status: SessionStatus;
  readonly tier: AgentTier;
  readonly messages: readonly AgentMessage[];
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** Lightweight projection for the project picker and history list. */
export interface SessionSummary {
  readonly id: Id<"session">;
  readonly projectId: Id<"project">;
  readonly title: string;
  readonly surface: Surface;
  readonly messageCount: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}
