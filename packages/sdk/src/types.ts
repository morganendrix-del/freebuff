import type {
  AdSelection,
  AgentMessage,
  AgentTier,
  Id,
  ProjectRef,
  QuotaDecision,
  QuotaSnapshot,
  Session,
  SessionSummary,
  Surface,
} from "@freebuff/shared";

export interface AuthUser {
  readonly id: Id<"user">;
  readonly email: string;
  readonly displayName: string;
  readonly tier: AgentTier;
  readonly countryCode: string;
  readonly timeZone: string;
  readonly phoneVerified: boolean;
  readonly createdAt: string;
}

export interface LoginResult {
  readonly token: string;
  readonly user: AuthUser;
  readonly isNewUser: boolean;
}

export interface CreateSessionInput {
  readonly projectId: Id<"project">;
  readonly surface: Surface;
  readonly title: string;
}

export interface RegisterProjectInput {
  readonly name: string;
  readonly rootPath: string;
  readonly gitRemote?: string;
}

export interface AdRequest {
  readonly surface: Surface;
  readonly contextTags: readonly string[];
}

export interface TerminalHandle {
  /** Platform-issued handle; opaque outside the platform. */
  readonly id: string;
  readonly sessionId: Id<"session">;
  readonly createdAt: string;
}

export interface TerminalExecResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly durationMs: number;
}

export interface TerminalExecOptions {
  readonly timeoutMs?: number;
  readonly cwd?: string;
  readonly signal?: AbortSignal;
}

/** Everything the platform exposes to its clients. Implemented by the HTTP client and by test fakes. */
export interface PlatformClient {
  readonly baseUrl: string;
  readonly auth: {
    login(email: string): Promise<LoginResult>;
    me(): Promise<AuthUser>;
  };
  readonly projects: {
    list(): Promise<readonly ProjectRef[]>;
    register(input: RegisterProjectInput): Promise<ProjectRef>;
  };
  readonly sessions: {
    list(projectId?: Id<"project">): Promise<readonly SessionSummary[]>;
    create(input: CreateSessionInput): Promise<Session>;
    get(sessionId: Id<"session">): Promise<Session>;
    appendMessages(sessionId: Id<"session">, messages: readonly AgentMessage[]): Promise<Session>;
  };
  readonly quota: {
    snapshot(): Promise<QuotaSnapshot>;
    authorizeRun(): Promise<QuotaDecision>;
  };
  readonly ads: {
    select(input: AdRequest): Promise<AdSelection | null>;
  };
  readonly terminals: {
    create(sessionId: Id<"session">): Promise<TerminalHandle>;
    exec(
      terminalId: string,
      command: string,
      options?: TerminalExecOptions,
    ): Promise<TerminalExecResult>;
    close(terminalId: string): Promise<void>;
  };
}
