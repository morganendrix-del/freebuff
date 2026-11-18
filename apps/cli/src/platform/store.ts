import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

import { createId } from "@freebuff/shared";
import type {
  AgentMessage,
  AgentTier,
  Id,
  ProjectRef,
  Session,
  SessionStatus,
  Surface,
} from "@freebuff/shared";

export interface StoredUser {
  readonly id: Id<"user">;
  readonly email: string;
  readonly displayName: string;
  readonly tier: AgentTier;
  readonly countryCode: string;
  readonly timeZone: string;
  readonly phoneVerified: boolean;
  readonly createdAt: string;
  readonly token: string;
}

export interface StoredProject {
  readonly ownerId: Id<"user">;
  readonly project: ProjectRef;
}

export interface PlatformState {
  readonly users: readonly StoredUser[];
  readonly projects: readonly StoredProject[];
  readonly sessions: readonly Session[];
}

export const EMPTY_STATE: PlatformState = { users: [], projects: [], sessions: [] };

function isState(value: unknown): value is PlatformState {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as { users?: unknown; projects?: unknown; sessions?: unknown };
  return (
    Array.isArray(candidate.users) &&
    Array.isArray(candidate.projects) &&
    Array.isArray(candidate.sessions)
  );
}

/**
 * Durable platform metadata for the local runtime: users, tokens, projects and chat sessions. Every
 * mutation is persisted atomically before it is acknowledged, so history survives a restart.
 */
export class PlatformStore {
  private state: PlatformState;

  constructor(private readonly filePath: string) {
    this.state = this.load();
  }

  get path(): string {
    return this.filePath;
  }

  read(): PlatformState {
    return this.state;
  }

  update(mutator: (state: PlatformState) => PlatformState): PlatformState {
    const next = mutator(this.state);
    this.persist(next);
    this.state = next;
    return next;
  }

  findUserByToken(token: string): StoredUser | undefined {
    return this.state.users.find((user) => user.token === token);
  }

  private load(): PlatformState {
    let raw: string;
    try {
      raw = readFileSync(this.filePath, "utf8");
    } catch {
      return EMPTY_STATE;
    }
    try {
      const parsed: unknown = JSON.parse(raw);
      return isState(parsed) ? parsed : EMPTY_STATE;
    } catch {
      return EMPTY_STATE;
    }
  }

  private persist(next: PlatformState): void {
    mkdirSync(path.dirname(this.filePath), { recursive: true });
    const temporary = `${this.filePath}.${String(process.pid)}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(next, null, 2)}\n`, "utf8");
    renameSync(temporary, this.filePath);
  }
}

export interface CreateUserInput {
  readonly email: string;
  readonly countryCode: string;
  readonly timeZone: string;
  readonly now: Date;
}

export function createStoredUser(input: CreateUserInput): StoredUser {
  const local = input.email.split("@")[0] ?? "developer";
  return {
    id: createId("user"),
    email: input.email,
    displayName: local,
    tier: "free",
    countryCode: input.countryCode,
    timeZone: input.timeZone,
    phoneVerified: false,
    createdAt: input.now.toISOString(),
    token: `fb_${crypto.randomUUID().replaceAll("-", "")}`,
  };
}

export interface CreateSessionRecordInput {
  readonly userId: Id<"user">;
  readonly project: ProjectRef;
  readonly surface: Surface;
  readonly title: string;
  readonly tier: AgentTier;
  readonly now: Date;
}

export function createSessionRecord(input: CreateSessionRecordInput): Session {
  const status: SessionStatus = "active";
  return {
    id: createId("session"),
    userId: input.userId,
    project: input.project,
    surface: input.surface,
    title: input.title,
    status,
    tier: input.tier,
    messages: [],
    createdAt: input.now.toISOString(),
    updatedAt: input.now.toISOString(),
  };
}

export function withMessages(
  session: Session,
  messages: readonly AgentMessage[],
  now: Date,
): Session {
  return {
    ...session,
    messages: [...session.messages, ...messages],
    updatedAt: now.toISOString(),
  };
}
