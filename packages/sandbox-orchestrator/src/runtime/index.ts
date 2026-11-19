import { messageOf, SandboxError, isSandboxError } from "../errors";
import { runCommand } from "../exec";
import type { CommandLimits } from "../exec";
import { PreviewSupervisor, assertPreviewPort } from "../preview";
import type { PreviewState } from "../preview";
import { WorkspaceJail } from "../workspace";

/**
 * The sandbox runtime: the only process that executes untrusted code.
 *
 * It is copied into the sandbox image and also runs as a plain child process under the development
 * provider, so the same enforcement code is exercised in tests and in production. It depends on
 * `node:` builtins only — no workspace packages — because the image ships without node_modules.
 *
 * Endpoints (all JSON, all behind the runtime token once configured):
 *   POST /exec            { command, cwd?, timeoutMs?, env? } -> RunResult
 *   POST /files/read      { path }                            -> { content }
 *   POST /files/write     { path, content }                   -> { ok: true }
 *   POST /files/list      { limit? }                          -> { files }
 *   POST /files/exists    { path }                            -> { exists }
 *   POST /preview/start   { command, cwd?, port?, timeoutMs? } -> PreviewState
 *   GET  /preview                                             -> PreviewState
 *   POST /preview/stop                                        -> PreviewState
 *   *    /preview/proxy/*                                     -> proxied preview response
 *   GET  /health, /info
 *   POST /shutdown
 */

export interface RuntimeLimits extends CommandLimits {
  readonly commandTimeoutMs: number;
  readonly maxOutputBytes: number;
}

export interface SandboxRuntimeOptions {
  readonly workspace: string;
  readonly sandboxId?: string;
  readonly token?: string;
  readonly limits?: Partial<RuntimeLimits>;
  readonly egressMode?: "allowlist" | "deny_all" | "open";
  readonly isolation?: "container" | "microvm" | "process";
  readonly previewTimeoutMs?: number;
}

export interface SandboxRuntime {
  readonly sandboxId: string;
  release(): Promise<void>;
  handle(request: Request): Promise<Response>;
}

const DEFAULT_LIMITS: RuntimeLimits = {
  commandTimeoutMs: 120_000,
  maxOutputBytes: 256 * 1024,
  memoryMb: 2048,
  cpuSeconds: 120,
  pids: 256,
  fileSizeMb: 512,
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

function errorResponse(error: unknown): Response {
  if (isSandboxError(error)) {
    const status =
      error.code === "invalid_input"
        ? 400
        : error.code === "permission_denied"
          ? 403
          : error.code === "not_found"
            ? 404
            : error.code === "conflict"
              ? 409
              : error.code === "output_too_large"
                ? 413
                : error.code === "timeout"
                  ? 504
                  : error.code === "not_configured"
                    ? 501
                    : 500;
    return json({ error: { code: error.code, message: error.message } }, status);
  }
  return json({ error: { code: "internal", message: messageOf(error) } }, 500);
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new SandboxError("invalid_input", "Expected a JSON object body.");
  }
  return value as Record<string, unknown>;
}

function readString(body: Record<string, unknown>, key: string): string {
  const value = body[key];
  if (typeof value !== "string" || value.trim() === "") {
    throw new SandboxError("invalid_input", `"${key}" must be a non-empty string.`);
  }
  return value;
}

function optionalNumber(body: Record<string, unknown>, key: string): number | undefined {
  const value = body[key];
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new SandboxError("invalid_input", `"${key}" must be a number.`);
  }
  return value;
}

function optionalStringMap(
  body: Record<string, unknown>,
  key: string,
): Record<string, string> | undefined {
  const value = body[key];
  if (value === undefined) return undefined;
  const record = asRecord(value);
  const output: Record<string, string> = {};
  for (const [name, entry] of Object.entries(record)) {
    if (typeof entry !== "string") {
      throw new SandboxError("invalid_input", `Environment value "${name}" must be a string.`);
    }
    output[name] = entry;
  }
  return output;
}

async function readJson(request: Request): Promise<Record<string, unknown>> {
  const text = await request.text();
  if (text.trim() === "") return {};
  try {
    return asRecord(JSON.parse(text) as unknown);
  } catch (error) {
    if (isSandboxError(error)) throw error;
    throw new SandboxError("invalid_input", "Malformed JSON body.");
  }
}

const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "content-encoding",
  "content-length",
  "keep-alive",
  "transfer-encoding",
  "upgrade",
]);

export async function createSandboxRuntime(
  options: SandboxRuntimeOptions,
): Promise<SandboxRuntime> {
  const limits: RuntimeLimits = { ...DEFAULT_LIMITS, ...options.limits };
  const sandboxId = options.sandboxId ?? "local";
  const jail = new WorkspaceJail(options.workspace);
  const preview = new PreviewSupervisor();
  await jail.init();

  const previewState = (): PreviewState => preview.state();

  const handleExec = async (request: Request): Promise<Response> => {
    const body = await readJson(request);
    const command = readString(body, "command");
    const cwd = body.cwd === undefined ? jail.root : jail.resolve(readString(body, "cwd"));
    const timeoutMs = optionalNumber(body, "timeoutMs") ?? limits.commandTimeoutMs;

    if (timeoutMs > limits.commandTimeoutMs) {
      throw new SandboxError(
        "invalid_input",
        `Command timeout exceeds the sandbox limit of ${String(limits.commandTimeoutMs)} ms.`,
      );
    }

    const result = await runCommand({
      command,
      cwd,
      timeoutMs,
      limits,
      maxOutputBytes: limits.maxOutputBytes,
      ...(optionalStringMap(body, "env") === undefined
        ? {}
        : { env: optionalStringMap(body, "env") ?? {} }),
    });
    return json(result);
  };

  const handlePreviewStart = async (request: Request): Promise<Response> => {
    const body = await readJson(request);
    const command = readString(body, "command");
    const cwd = body.cwd === undefined ? jail.root : jail.resolve(readString(body, "cwd"));
    const port = optionalNumber(body, "port");
    const expectedPort = port === undefined ? undefined : assertPreviewPort(port);

    const state = await preview.start({
      command,
      cwd,
      limits,
      ...(expectedPort === undefined ? {} : { expectedPort }),
      timeoutMs: optionalNumber(body, "timeoutMs") ?? options.previewTimeoutMs ?? 60_000,
    });
    return json(state, state.phase === "listening" ? 200 : 502);
  };

  const handlePreviewProxy = async (request: Request): Promise<Response> => {
    const port = preview.port;
    if (port === undefined) {
      throw new SandboxError("not_found", "No preview server is listening in this sandbox.");
    }

    const incoming = new URL(request.url);
    const suffix = incoming.pathname.replace(/^\/preview\/proxy/, "") || "/";
    const target = `http://127.0.0.1:${String(port)}${suffix}${incoming.search}`;
    const headers = new Headers(request.headers);
    headers.delete("host");
    headers.delete("connection");

    const init: RequestInit = {
      method: request.method,
      headers,
      redirect: "manual",
      signal: AbortSignal.timeout(30_000),
    };
    if (request.method !== "GET" && request.method !== "HEAD") {
      init.body = await request.arrayBuffer();
    }

    const upstream = await fetch(target, init);
    const responseHeaders = new Headers();
    upstream.headers.forEach((value, name) => {
      if (!HOP_BY_HOP_HEADERS.has(name.toLowerCase())) responseHeaders.set(name, value);
    });
    return new Response(await upstream.arrayBuffer(), {
      status: upstream.status,
      headers: responseHeaders,
    });
  };

  const handle = async (request: Request): Promise<Response> => {
    try {
      const url = new URL(request.url);
      const path = url.pathname;

      if (path === "/health") {
        if (options.token !== undefined && request.method !== "GET") {
          return json({ error: { code: "method_not_allowed", message: "GET only." } }, 405);
        }
        return json({ status: "ok" });
      }

      if (options.token !== undefined) {
        const authorization = request.headers.get("authorization");
        if (authorization !== `Bearer ${options.token}`) {
          return json({ error: { code: "unauthorized", message: "Invalid sandbox token." } }, 401);
        }
      }

      if (path === "/info" && request.method === "GET") {
        return json({
          service: "freebuff-sandbox",
          status: "ready",
          sandboxId,
          isolation: options.isolation ?? "container",
          egressMode: options.egressMode ?? "allowlist",
          workspace: jail.root,
          uid: process.getuid?.() ?? -1,
          limits,
        });
      }

      if (path === "/exec" && request.method === "POST") return await handleExec(request);

      if (path === "/files/read" && request.method === "POST") {
        const body = await readJson(request);
        return json({ content: await jail.read(readString(body, "path")) });
      }

      if (path === "/files/write" && request.method === "POST") {
        const body = await readJson(request);
        if (typeof body.content !== "string") {
          throw new SandboxError("invalid_input", `"content" must be a string.`);
        }
        await jail.write(readString(body, "path"), body.content);
        return json({ ok: true });
      }

      if (path === "/files/list" && request.method === "POST") {
        const body = await readJson(request);
        const limit = optionalNumber(body, "limit");
        return json({
          files: await jail.list(limit === undefined ? undefined : Math.floor(limit)),
        });
      }

      if (path === "/files/exists" && request.method === "POST") {
        const body = await readJson(request);
        return json({ exists: await jail.exists(readString(body, "path")) });
      }

      if (path === "/preview/start" && request.method === "POST") {
        return await handlePreviewStart(request);
      }

      if (path === "/preview" && request.method === "GET") {
        return json(previewState());
      }

      if (path === "/preview/stop" && request.method === "POST") {
        await preview.stop();
        return json(previewState());
      }

      if (path.startsWith("/preview/proxy")) return await handlePreviewProxy(request);

      if (path === "/shutdown" && request.method === "POST") {
        await preview.stop();
        return json({ ok: true });
      }

      return json({ error: { code: "not_found", message: "Unknown sandbox endpoint." } }, 404);
    } catch (error) {
      return errorResponse(error);
    }
  };

  return {
    sandboxId,
    async release() {
      await preview.stop();
    },
    handle,
  };
}
