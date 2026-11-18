import type {
  AdSelection,
  AgentMessage,
  Id,
  ProjectRef,
  QuotaDecision,
  QuotaSnapshot,
  Session,
  SessionSummary,
} from "@freebuff/shared";

import { HttpTransport } from "./http";
import type { HttpTransportOptions, SendOptions } from "./http";
import type {
  AdRequest,
  AuthUser,
  CreateSessionInput,
  LoginResult,
  PlatformClient,
  RegisterProjectInput,
  TerminalExecOptions,
  TerminalExecResult,
  TerminalHandle,
} from "./types";

export interface PlatformClientOptions extends HttpTransportOptions {
  readonly token?: string;
}

interface ListResponse<T> {
  readonly items: readonly T[];
}

/**
 * The only way any surface talks to the platform. No module outside this package may issue platform
 * HTTP requests (spec: CLI ↔ platform through the SDK).
 */
export function createPlatformClient(options: PlatformClientOptions): PlatformClient {
  const http = new HttpTransport(options);
  const send = <T>(request: SendOptions): Promise<T> => http.send<T>(request);

  return {
    baseUrl: options.baseUrl,

    auth: {
      login: (email) =>
        send<LoginResult>({ method: "POST", path: "/v1/auth/login", body: { email } }),
      me: () => send<AuthUser>({ method: "GET", path: "/v1/auth/me" }),
    },

    projects: {
      list: () =>
        send<ListResponse<ProjectRef>>({ method: "GET", path: "/v1/projects" }).then(
          (page) => page.items,
        ),
      register: (input: RegisterProjectInput) =>
        send<ProjectRef>({ method: "POST", path: "/v1/projects", body: input }),
    },

    sessions: {
      list: (projectId?: Id<"project">) =>
        send<ListResponse<SessionSummary>>({
          method: "GET",
          path: projectId === undefined ? "/v1/sessions" : `/v1/sessions?projectId=${projectId}`,
        }).then((page) => page.items),
      create: (input: CreateSessionInput) =>
        send<Session>({ method: "POST", path: "/v1/sessions", body: input }),
      get: (sessionId) => send<Session>({ method: "GET", path: `/v1/sessions/${sessionId}` }),
      appendMessages: (sessionId: Id<"session">, messages: readonly AgentMessage[]) =>
        send<Session>({
          method: "POST",
          path: `/v1/sessions/${sessionId}/messages`,
          body: { messages },
        }),
    },

    quota: {
      snapshot: () => send<QuotaSnapshot>({ method: "GET", path: "/v1/quota" }),
      authorizeRun: () => send<QuotaDecision>({ method: "POST", path: "/v1/quota/authorize" }),
    },

    ads: {
      select: (input: AdRequest) =>
        send<AdSelection | null>({ method: "POST", path: "/v1/ads/select", body: input }),
    },

    terminals: {
      create: (sessionId) =>
        send<TerminalHandle>({
          method: "POST",
          path: "/v1/terminals",
          body: { sessionId },
        }),
      exec: (terminalId, command, execOptions: TerminalExecOptions = {}) =>
        send<TerminalExecResult>({
          method: "POST",
          path: `/v1/terminals/${terminalId}/exec`,
          body: {
            command,
            ...(execOptions.cwd === undefined ? {} : { cwd: execOptions.cwd }),
            ...(execOptions.timeoutMs === undefined ? {} : { timeoutMs: execOptions.timeoutMs }),
          },
          ...(execOptions.signal === undefined ? {} : { signal: execOptions.signal }),
        }),
      close: async (terminalId) => {
        await send<null>({ method: "DELETE", path: `/v1/terminals/${terminalId}` });
      },
    },
  };
}
