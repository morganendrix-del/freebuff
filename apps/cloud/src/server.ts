import { timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";

import { createNullLogger } from "@freebuff/shared";
import type { Logger, RepoSource } from "@freebuff/shared";
import type { SandboxEvent, SandboxManager, SandboxRecord } from "@freebuff/sandbox-orchestrator";
import { SandboxError } from "@freebuff/sandbox-orchestrator";

import { dashboardHtml } from "./dashboard";

const MAX_BODY_BYTES = 64 * 1024;
const OWNER_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const NAME_PATTERN = /^[A-Za-z0-9._-]{1,100}$/;
const BRANCH_PATTERN = /^[A-Za-z0-9._/-]{1,200}$/;
const SANDBOX_ID_PATTERN = /^sandbox_[0-9a-f]{32}$/;

export interface CloudServerOptions {
  readonly manager: SandboxManager;
  /** When set, every API route requires `Authorization: Bearer <token>`. */
  readonly apiToken?: string;
  readonly port?: number;
  readonly hostname?: string;
  readonly logger?: Logger;
}

export interface CloudServer {
  readonly url: string;
  readonly port: number;
  close(): Promise<void>;
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(text);
}

function sendError(response: ServerResponse, status: number, code: string, message: string): void {
  sendJson(response, status, { error: { code, message } });
}

async function readBody(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    total += buffer.length;
    if (total > MAX_BODY_BYTES) {
      request.destroy();
      throw new SandboxError("invalid_input", "Request body is too large.");
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

async function readJsonBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  const text = (await readBody(request)).toString("utf8");
  if (text.trim() === "") return {};
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error("not an object");
    }
    return parsed as Record<string, unknown>;
  } catch (error) {
    throw new SandboxError("invalid_input", "Malformed JSON body.", { cause: error });
  }
}

function optionalString(body: Record<string, unknown>, key: string): string | undefined {
  const value = body[key];
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string") {
    throw new SandboxError("invalid_input", `"${key}" must be a string.`);
  }
  return value;
}

function parseRepo(body: Record<string, unknown>): RepoSource {
  const combined = optionalString(body, "repo");
  const owner = optionalString(body, "owner") ?? combined?.split("/")[0];
  const name = optionalString(body, "name") ?? combined?.split("/")[1];

  if (owner === undefined || name === undefined) {
    throw new SandboxError("invalid_input", 'Provide "repo": "owner/name" or "owner" and "name".');
  }
  if (!OWNER_PATTERN.test(owner)) {
    throw new SandboxError("invalid_input", `Invalid repository owner: ${owner}`);
  }
  if (!NAME_PATTERN.test(name)) {
    throw new SandboxError("invalid_input", `Invalid repository name: ${name}`);
  }

  const branch = optionalString(body, "branch");
  if (branch !== undefined && !BRANCH_PATTERN.test(branch)) {
    throw new SandboxError("invalid_input", `Invalid branch name: ${branch}`);
  }

  return {
    provider: "github",
    owner,
    name,
    ...(branch === undefined ? {} : { branch }),
  };
}

function isAuthorized(request: IncomingMessage, token: string | undefined): boolean {
  if (token === undefined) return true;
  const header = request.headers.authorization;
  if (header === undefined) return false;
  const expected = Buffer.from(`Bearer ${token}`);
  const received = Buffer.from(header);
  return expected.length === received.length && timingSafeEqual(expected, received);
}

function requestHeaders(request: IncomingMessage): Headers {
  const headers = new Headers();
  for (const [name, value] of Object.entries(request.headers)) {
    const lower = name.toLowerCase();
    if (value === undefined) continue;
    if (
      lower === "host" ||
      lower === "connection" ||
      lower === "content-length" ||
      lower === "transfer-encoding"
    ) {
      continue;
    }
    headers.set(name, Array.isArray(value) ? value.join(", ") : value);
  }
  return headers;
}

function recordOr404(
  manager: SandboxManager,
  id: string,
  response: ServerResponse,
): SandboxRecord | undefined {
  if (!SANDBOX_ID_PATTERN.test(id)) {
    sendError(response, 404, "not_found", "Sandbox not found.");
    return undefined;
  }
  const record = manager.get(id);
  if (record === undefined) {
    sendError(response, 404, "not_found", "Sandbox not found.");
    return undefined;
  }
  return record;
}

/**
 * Cloud API + dashboard.
 *
 * Routes: `GET /` dashboard, `POST /v1/sandboxes` import, `GET /v1/sandboxes`,
 * `GET /v1/sandboxes/:id`, `GET /v1/sandboxes/:id/events` (SSE), `POST /v1/sandboxes/:id/stop`,
 * and `GET|HEAD /preview/:id/*` which proxies the sandbox's dev server.
 *
 * Preview links are intentionally unauthenticated — they are the shareable artifact — but the
 * sandbox id is a 128-bit random value and the preview route cannot be used to reach the sandbox
 * control API.
 */
export async function startCloudServer(options: CloudServerOptions): Promise<CloudServer> {
  const logger = options.logger ?? createNullLogger();
  const { manager } = options;
  const port = options.port ?? 0;
  const hostname = options.hostname ?? "127.0.0.1";

  const handle = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const url = new URL(request.url ?? "/", "http://cloud.local");
    const path = url.pathname;
    const method = request.method ?? "GET";

    if (path === "/health") {
      sendJson(response, 200, { status: "ok" });
      return;
    }

    const previewMatch = /^\/preview\/([^/]+)(\/.*)?$/.exec(path);
    if (previewMatch !== null) {
      const id = previewMatch[1] ?? "";
      const suffix = previewMatch[2] ?? "/";
      const record = recordOr404(manager, id, response);
      if (record === undefined) return;

      const instance = manager.instance(id);
      if (instance === undefined) {
        sendError(response, 409, "conflict", "This sandbox is not running.");
        return;
      }

      const init: RequestInit = {
        method,
        headers: requestHeaders(request),
        redirect: "manual",
      };
      if (method !== "GET" && method !== "HEAD") {
        init.body = new Uint8Array(await readBody(request));
      }

      const upstream = await instance.proxyPreview(
        new Request(`http://sandbox.local${suffix === "" ? "/" : suffix}${url.search}`, init),
      );
      const headers: Record<string, string | string[]> = {};
      upstream.headers.forEach((value, name) => {
        headers[name] = value;
      });
      const cookies = upstream.headers.getSetCookie();
      if (cookies.length > 0) headers["set-cookie"] = cookies;
      response.writeHead(upstream.status, headers);
      response.end(Buffer.from(await upstream.arrayBuffer()));
      return;
    }

    if (!isAuthorized(request, options.apiToken)) {
      sendError(response, 401, "unauthorized", "A cloud API token is required.");
      return;
    }

    if (path === "/" && method === "GET") {
      const html = dashboardHtml();
      response.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
        "content-security-policy":
          "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'",
      });
      response.end(html);
      return;
    }

    if (path === "/v1/sandboxes" && method === "GET") {
      sendJson(response, 200, { sandboxes: manager.list() });
      return;
    }

    if (path === "/v1/sandboxes" && method === "POST") {
      const body = await readJsonBody(request);
      const repo = parseRepo(body);
      const cloneUrl = optionalString(body, "cloneUrl");
      const previewCommand = optionalString(body, "previewCommand");

      let announce: (record: SandboxRecord) => void = () => undefined;
      const created = new Promise<SandboxRecord>((resolve) => {
        announce = resolve;
      });

      void manager
        .create(
          {
            repo,
            ...(cloneUrl === undefined ? {} : { cloneUrl }),
            ...(previewCommand === undefined ? {} : { previewCommand }),
          },
          { onCreated: announce },
        )
        .then((record) => {
          announce(record);
          logger.info("sandbox finished", { sandboxId: record.id, status: record.status });
        })
        .catch((error: unknown) => {
          logger.error("sandbox failed to start", error, { repo: `${repo.owner}/${repo.name}` });
        });

      sendJson(response, 202, await created);
      return;
    }

    const sandboxMatch = /^\/v1\/sandboxes\/([^/]+)(?:\/(events|stop))?$/.exec(path);
    if (sandboxMatch !== null) {
      const id = sandboxMatch[1] ?? "";
      const action = sandboxMatch[2];
      const record = recordOr404(manager, id, response);
      if (record === undefined) return;

      if (action === "events" && method === "GET") {
        response.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-store",
          connection: "keep-alive",
        });

        const send = (event: SandboxEvent): void => {
          response.write(`data: ${JSON.stringify(event)}\n\n`);
        };
        for (const event of manager.events(id)) send(event);

        const unsubscribe = manager.subscribe(id, send);
        const heartbeat = setInterval(() => {
          response.write(": ping\n\n");
        }, 15_000);

        request.on("close", () => {
          clearInterval(heartbeat);
          unsubscribe();
        });
        return;
      }

      if (action === "stop" && method === "POST") {
        const stopped = await manager.stop(id);
        sendJson(response, 200, { sandbox: stopped ?? record });
        return;
      }

      if (action === undefined && method === "GET") {
        sendJson(response, 200, { sandbox: record });
        return;
      }

      sendError(response, 405, "invalid_request", "Method not allowed for this route.");
      return;
    }

    sendError(response, 404, "not_found", "Unknown cloud route.");
  };

  const server = createServer((request, response) => {
    void handle(request, response).catch((error: unknown) => {
      if (response.headersSent) {
        response.end();
        return;
      }
      if (error instanceof SandboxError) {
        sendError(
          response,
          error.code === "invalid_input" ? 400 : error.code === "not_found" ? 404 : 500,
          error.code,
          error.message,
        );
        return;
      }
      logger.error("cloud request failed", error);
      sendError(response, 500, "internal", "The request failed.");
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, hostname, () => {
      server.removeListener("error", reject);
      resolve();
    });
  });

  const address = server.address();
  const boundPort = typeof address === "object" && address !== null ? address.port : port;
  const host = hostname === "0.0.0.0" ? "127.0.0.1" : hostname;

  return {
    url: `http://${host}:${String(boundPort)}`,
    port: boundPort,
    async close() {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) reject(error);
          else resolve();
        });
      });
    },
  };
}
