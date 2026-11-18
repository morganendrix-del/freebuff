import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import path from "node:path";

import { QuotaTracker } from "@freebuff/quota";
import { resolveInsideRoot } from "@freebuff/agent-runtime";
import { createId } from "@freebuff/shared";
import type {
  AdSelection,
  AgentMessage,
  ApiErrorCode,
  ContentBlock,
  Id,
  MessageRole,
  ProjectRef,
  QuotaDecision,
  Session,
  SessionSummary,
  Surface,
} from "@freebuff/shared";

import { resolveConfigDirectory } from "../config";
import { createLocalTerminalBroker } from "../terminal/broker";
import type { TerminalBroker } from "../terminal/broker";
import { selectCreative } from "./ads";
import { PlatformStore, createSessionRecord, createStoredUser, withMessages } from "./store";
import type { StoredUser } from "./store";

const MAX_BODY_BYTES = 1_000_000;
const SURFACES: readonly Surface[] = ["cli", "cloud", "desktop", "web"];

class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: ApiErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

export interface LocalPlatformOptions {
  readonly storePath?: string;
  readonly host?: string;
  readonly port?: number;
  readonly now?: () => Date;
  readonly random?: () => number;
  readonly broker?: TerminalBroker;
  readonly countryCode?: string;
  readonly timeZone?: string;
}

export interface LocalPlatform {
  readonly url: string;
  readonly port: number;
  readonly storePath: string;
  close(): Promise<void>;
}

interface TerminalRecord {
  readonly sessionId: Id<"session">;
  readonly rootPath: string;
  readonly ownerId: Id<"user">;
}

/**
 * The local platform API the CLI talks to through `@freebuff/sdk`. It is a real HTTP service with
 * durable state — not an in-process fake — so the CLI exercises the same code path a hosted API will
 * use in Phase 3. Ownership, quota and ad decisions happen here, never in the client.
 */
export async function startLocalPlatform(
  options: LocalPlatformOptions = {},
): Promise<LocalPlatform> {
  const now = options.now ?? ((): Date => new Date());
  const storePath =
    options.storePath ?? path.join(resolveConfigDirectory(), "platform", "platform.json");
  const store = new PlatformStore(storePath);
  const quota = new QuotaTracker({ now });
  const broker = options.broker ?? createLocalTerminalBroker();
  const terminals = new Map<string, TerminalRecord>();
  const defaultCountry = options.countryCode ?? process.env.FREEBUFF_COUNTRY_CODE ?? "US";
  const defaultTimeZone =
    options.timeZone ??
    process.env.FREEBUFF_TIME_ZONE ??
    Intl.DateTimeFormat().resolvedOptions().timeZone;

  const server: Server = createServer((request, response) => {
    void handle(request, response).catch((error: unknown) => {
      const failure =
        error instanceof HttpError
          ? error
          : new HttpError(500, "internal", "The platform hit an unexpected error.");
      respond(response, failure.status, {
        ok: false,
        error: {
          code: failure.code,
          message: failure.message,
          requestId: String(request.headers["x-request-id"] ?? createId("run")),
        },
      });
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 0, options.host ?? "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });

  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  const host = options.host ?? "127.0.0.1";

  let closed = false;
  const platform: LocalPlatform = {
    url: `http://${host}:${String(port)}`,
    port,
    storePath,
    async close() {
      // Idempotent: shutdown from a command and from a test cleanup may both run.
      if (closed) return;
      closed = true;
      broker.closeAll();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) reject(error);
          else resolve();
        });
      });
    },
  };

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? "/", `http://${request.headers.host ?? host}`);
    const method = request.method ?? "GET";
    const route = `${method} ${url.pathname}`;

    if (route === "GET /v1/health") {
      respond(response, 200, { ok: true, data: { status: "ok", serverTime: now().toISOString() } });
      return;
    }

    if (route === "POST /v1/auth/login") {
      const body = await readJson(request);
      const email = requireString(body, "email").trim().toLowerCase();
      if (!email.includes("@"))
        throw new HttpError(400, "invalid_request", "A valid email is required.");

      const existing = store.read().users.find((user) => user.email === email);
      if (existing !== undefined) {
        respond(response, 200, {
          ok: true,
          data: { token: existing.token, user: toAuthUser(existing), isNewUser: false },
        });
        return;
      }

      const user = createStoredUser({
        email,
        countryCode: defaultCountry,
        timeZone: defaultTimeZone,
        now: now(),
      });
      store.update((state) => ({ ...state, users: [...state.users, user] }));
      respond(response, 200, {
        ok: true,
        data: { token: user.token, user: toAuthUser(user), isNewUser: true },
      });
      return;
    }

    const user = authenticate(request, store);

    if (route === "GET /v1/auth/me") {
      respond(response, 200, { ok: true, data: toAuthUser(user) });
      return;
    }

    if (route === "GET /v1/projects") {
      const projects = store
        .read()
        .projects.filter((entry) => entry.ownerId === user.id)
        .map((entry) => entry.project);
      respond(response, 200, { ok: true, data: { items: projects } });
      return;
    }

    if (route === "POST /v1/projects") {
      const body = await readJson(request);
      const rootPath = path.resolve(requireString(body, "rootPath"));
      const name = requireString(body, "name");
      const existing = store
        .read()
        .projects.find((entry) => entry.ownerId === user.id && entry.project.rootPath === rootPath);
      if (existing !== undefined) {
        respond(response, 200, { ok: true, data: existing.project });
        return;
      }

      const project: ProjectRef = {
        id: createId("project"),
        name,
        rootPath,
        ...(typeof body.gitRemote === "string" ? { gitRemote: body.gitRemote } : {}),
      };
      store.update((state) => ({
        ...state,
        projects: [...state.projects, { ownerId: user.id, project }],
      }));
      respond(response, 201, { ok: true, data: project });
      return;
    }

    if (route === "GET /v1/sessions") {
      const projectId = url.searchParams.get("projectId");
      const sessions = store
        .read()
        .sessions.filter(
          (session) =>
            session.userId === user.id &&
            (projectId === null || session.project.id === (projectId as Id<"project">)),
        )
        .map(toSessionSummary);
      respond(response, 200, { ok: true, data: { items: sessions } });
      return;
    }

    if (route === "POST /v1/sessions") {
      const body = await readJson(request);
      const projectId = requireString(body, "projectId") as Id<"project">;
      const project = store
        .read()
        .projects.find((entry) => entry.ownerId === user.id && entry.project.id === projectId);
      if (project === undefined) throw new HttpError(404, "not_found", "Project not found.");

      const surface = parseSurface(body.surface);
      const title =
        typeof body.title === "string" && body.title.trim() !== "" ? body.title : "New session";
      const session = createSessionRecord({
        userId: user.id,
        project: project.project,
        surface,
        title,
        tier: user.tier,
        now: now(),
      });
      store.update((state) => ({ ...state, sessions: [...state.sessions, session] }));
      respond(response, 201, { ok: true, data: session });
      return;
    }

    const sessionMatch = /^\/v1\/sessions\/([^/]+)$/.exec(url.pathname);
    if (sessionMatch !== null) {
      const sessionId = sessionMatch[1] ?? "";
      const session = ownedSession(store, user, sessionId);

      if (method === "GET") {
        respond(response, 200, { ok: true, data: session });
        return;
      }
    }

    const messagesMatch = /^\/v1\/sessions\/([^/]+)\/messages$/.exec(url.pathname);
    if (method === "POST" && messagesMatch !== null) {
      const session = ownedSession(store, user, messagesMatch[1] ?? "");
      const body = await readJson(request);
      const messages = parseMessages(body.messages);
      const updated = withMessages(session, messages, now());
      store.update((state) => ({
        ...state,
        sessions: state.sessions.map((entry) => (entry.id === updated.id ? updated : entry)),
      }));
      respond(response, 200, { ok: true, data: updated });
      return;
    }

    if (route === "GET /v1/quota") {
      respond(response, 200, { ok: true, data: quota.snapshot(accountFor(user)) });
      return;
    }

    if (route === "POST /v1/quota/authorize") {
      const decision: QuotaDecision = quota.decide(accountFor(user));
      respond(response, 200, { ok: true, data: decision });
      return;
    }

    if (route === "POST /v1/ads/select") {
      const body = await readJson(request);
      const surface = parseSurface(body.surface);
      const rawTags: unknown = body.contextTags;
      const contextTags = Array.isArray(rawTags)
        ? rawTags.filter((tag: unknown): tag is string => typeof tag === "string")
        : [];
      const selection: AdSelection | null = selectCreative({
        context: {
          surface,
          tier: user.tier,
          locale: typeof body.locale === "string" ? body.locale : "en",
          contextTags,
        },
        ...(options.random === undefined ? {} : { random: options.random }),
      });
      respond(response, 200, { ok: true, data: selection });
      return;
    }

    if (route === "POST /v1/terminals") {
      const body = await readJson(request);
      const session = ownedSession(store, user, requireString(body, "sessionId"));
      const handle = broker.open({ cwd: session.project.rootPath });
      terminals.set(handle.id, {
        sessionId: session.id,
        rootPath: session.project.rootPath,
        ownerId: user.id,
      });
      respond(response, 201, {
        ok: true,
        data: { id: handle.id, sessionId: session.id, createdAt: now().toISOString() },
      });
      return;
    }

    const execMatch = /^\/v1\/terminals\/([^/]+)\/exec$/.exec(url.pathname);
    if (method === "POST" && execMatch !== null) {
      const terminalId = execMatch[1] ?? "";
      const record = terminals.get(terminalId);
      if (record?.ownerId !== user.id) {
        throw new HttpError(404, "not_found", "Terminal not found.");
      }
      const body = await readJson(request);
      const command = requireString(body, "command");
      const cwd =
        typeof body.cwd === "string" ? resolveInsideRoot(record.rootPath, body.cwd) : undefined;
      const result = await broker.exec(terminalId, command, {
        ...(cwd === undefined ? {} : { cwd }),
        ...(typeof body.timeoutMs === "number" ? { timeoutMs: body.timeoutMs } : {}),
      });
      respond(response, 200, {
        ok: true,
        data: {
          exitCode: result.exitCode,
          stdout: result.stdout,
          stderr: result.stderr,
          durationMs: result.durationMs,
        },
      });
      return;
    }

    const closeMatch = /^\/v1\/terminals\/([^/]+)$/.exec(url.pathname);
    if (method === "DELETE" && closeMatch !== null) {
      const terminalId = closeMatch[1] ?? "";
      const record = terminals.get(terminalId);
      if (record?.ownerId !== user.id) {
        throw new HttpError(404, "not_found", "Terminal not found.");
      }
      broker.close(terminalId);
      terminals.delete(terminalId);
      respond(response, 200, { ok: true, data: null });
      return;
    }

    throw new HttpError(404, "not_found", `No route for ${route}.`);
  }

  function authenticate(request: IncomingMessage, store: PlatformStore): StoredUser {
    const header = request.headers.authorization;
    if (typeof header !== "string" || !header.startsWith("Bearer ")) {
      throw new HttpError(401, "unauthorized", "A bearer token is required.");
    }
    const user = store.findUserByToken(header.slice("Bearer ".length));
    if (user === undefined) throw new HttpError(401, "unauthorized", "The token is not valid.");
    return user;
  }

  function ownedSession(store: PlatformStore, user: StoredUser, sessionId: string): Session {
    const session = store.read().sessions.find((entry) => entry.id === sessionId);
    if (session?.userId !== user.id) {
      throw new HttpError(404, "not_found", "Session not found.");
    }
    return session;
  }

  function accountFor(user: StoredUser): {
    userId: Id<"user">;
    tier: StoredUser["tier"];
    countryCode: string;
    timeZone: string;
    phoneVerified: boolean;
  } {
    return {
      userId: user.id,
      tier: user.tier,
      countryCode: user.countryCode,
      timeZone: user.timeZone,
      phoneVerified: user.phoneVerified,
    };
  }

  return platform;
}

function toAuthUser(user: StoredUser): {
  id: Id<"user">;
  email: string;
  displayName: string;
  tier: StoredUser["tier"];
  countryCode: string;
  timeZone: string;
  phoneVerified: boolean;
  createdAt: string;
} {
  return {
    id: user.id,
    email: user.email,
    displayName: user.displayName,
    tier: user.tier,
    countryCode: user.countryCode,
    timeZone: user.timeZone,
    phoneVerified: user.phoneVerified,
    createdAt: user.createdAt,
  };
}

function toSessionSummary(session: Session): SessionSummary {
  return {
    id: session.id,
    projectId: session.project.id,
    title: session.title,
    surface: session.surface,
    messageCount: session.messages.length,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
  };
}

function parseSurface(value: unknown): Surface {
  const surface = typeof value === "string" ? value : "cli";
  const found = SURFACES.find((candidate) => candidate === surface);
  if (found === undefined)
    throw new HttpError(400, "invalid_request", `Unknown surface "${surface}".`);
  return found;
}

const MESSAGE_ROLES: readonly MessageRole[] = ["assistant", "system", "tool", "user"];

function parseMessages(value: unknown): readonly AgentMessage[] {
  if (!Array.isArray(value)) {
    throw new HttpError(400, "invalid_request", "messages must be an array.");
  }
  return (value as readonly unknown[]).map((entry) => {
    if (typeof entry !== "object" || entry === null) {
      throw new HttpError(400, "invalid_request", "Each message must be an object.");
    }
    const message = entry as Partial<AgentMessage>;
    const role = MESSAGE_ROLES.find((candidate) => candidate === message.role);
    if (typeof message.id !== "string" || role === undefined) {
      throw new HttpError(400, "invalid_request", "Messages need an id and a valid role.");
    }
    if (!Array.isArray(message.content)) {
      throw new HttpError(400, "invalid_request", "Messages need a content array.");
    }
    return {
      id: message.id,
      role,
      content: message.content as readonly ContentBlock[],
      createdAt:
        typeof message.createdAt === "string" ? message.createdAt : new Date().toISOString(),
    };
  });
}

async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request as AsyncIterable<Buffer>) {
    const buffer = chunk;
    size += buffer.byteLength;
    if (size > MAX_BODY_BYTES)
      throw new HttpError(413, "invalid_request", "Request body too large.");
    chunks.push(buffer);
  }
  if (chunks.length === 0) return {};
  try {
    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new HttpError(400, "invalid_request", "Expected a JSON object.");
    }
    return parsed as Record<string, unknown>;
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(400, "invalid_request", "Malformed JSON body.");
  }
}

function requireString(body: Record<string, unknown>, key: string): string {
  const value = body[key];
  if (typeof value !== "string" || value.trim() === "") {
    throw new HttpError(400, "invalid_request", `"${key}" is required.`);
  }
  return value;
}

function respond(response: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
  });
  response.end(body);
}
