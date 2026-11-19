import { request } from "node:http";

import type { SandboxSpec } from "@freebuff/shared";

import { SandboxError } from "./errors";
import type { ExecOptions, SandboxInstance, SandboxProvider } from "./provider";
import { assertPreviewPort } from "./preview";
import type { PreviewStartOptions, PreviewState } from "./preview";
import type { RunResult } from "./exec";

export interface RuntimeClientOptions {
  readonly origin: string;
  readonly token?: string;
  readonly timeoutMs?: number;
}

interface RuntimeErrorBody {
  readonly error?: { readonly code?: string; readonly message?: string };
}

const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * HTTP client for the sandbox runtime control API (`packages/sandbox-orchestrator/src/runtime`).
 * Used by providers whose runtime lives behind a network port (Docker), so exec/files/preview all go
 * through the same enforced entry point as production.
 */
export class SandboxRuntimeClient {
  readonly #origin: string;
  readonly #token: string | undefined;
  readonly #timeoutMs: number;

  constructor(options: RuntimeClientOptions) {
    this.#origin = options.origin.replace(/\/+$/, "");
    this.#token = options.token;
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async exec(options: ExecOptions): Promise<RunResult> {
    return await this.#json<RunResult>("POST", "/exec", {
      command: options.command,
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
      ...(options.env === undefined ? {} : { env: options.env }),
    });
  }

  async readFile(path: string): Promise<string> {
    const body = await this.#json<{ content: string }>("POST", "/files/read", { path });
    return body.content;
  }

  async writeFile(path: string, content: string): Promise<void> {
    await this.#json("POST", "/files/write", { path, content });
  }

  async listFiles(limit?: number): Promise<string[]> {
    const body = await this.#json<{ files: string[] }>(
      "POST",
      "/files/list",
      limit === undefined ? {} : { limit },
    );
    return body.files;
  }

  async exists(path: string): Promise<boolean> {
    const body = await this.#json<{ exists: boolean }>("POST", "/files/exists", { path });
    return body.exists;
  }

  async startPreview(
    options: Omit<PreviewStartOptions, "cwd"> & { readonly cwd?: string },
  ): Promise<PreviewState> {
    return await this.#json<PreviewState>(
      "POST",
      "/preview/start",
      {
        command: options.command,
        ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
        ...(options.expectedPort === undefined
          ? {}
          : { port: assertPreviewPort(options.expectedPort) }),
        ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
      },
      90_000,
    );
  }

  async preview(): Promise<PreviewState> {
    return await this.#json<PreviewState>("GET", "/preview");
  }

  async stopPreview(): Promise<PreviewState> {
    return await this.#json<PreviewState>("POST", "/preview/stop", {});
  }

  async info(): Promise<unknown> {
    return await this.#json<unknown>("GET", "/info");
  }

  async proxyPreview(request: Request): Promise<Response> {
    const incoming = new URL(request.url);
    const target = `${this.#origin}/preview/proxy${incoming.pathname}${incoming.search}`;
    const headers = new Headers(request.headers);
    headers.delete("host");
    headers.delete("connection");
    if (this.#token !== undefined) headers.set("authorization", `Bearer ${this.#token}`);
    return await fetch(target, {
      method: request.method,
      headers,
      redirect: "manual",
      signal: AbortSignal.timeout(30_000),
      ...(request.method === "GET" || request.method === "HEAD"
        ? {}
        : { body: await request.arrayBuffer() }),
    });
  }

  async #json<T>(
    method: "GET" | "POST",
    path: string,
    body?: unknown,
    timeoutMs?: number,
  ): Promise<T> {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const headers: Record<string, string> = { accept: "application/json" };
    if (payload !== undefined) headers["content-type"] = "application/json";
    if (this.#token !== undefined) headers.authorization = `Bearer ${this.#token}`;

    const responseText = await new Promise<string>((resolve, reject) => {
      const req = request(
        `${this.#origin}${path}`,
        { method, headers, timeout: timeoutMs ?? this.#timeoutMs },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (chunk: Buffer) => chunks.push(chunk));
          res.on("end", () => {
            const status = res.statusCode ?? 0;
            const text = Buffer.concat(chunks).toString("utf8");
            if (status >= 400) {
              let parsed: RuntimeErrorBody = {};
              try {
                parsed = JSON.parse(text) as RuntimeErrorBody;
              } catch {
                // Non-JSON error body: fall through to the status-based message.
              }
              reject(
                new SandboxError(
                  "internal",
                  parsed.error?.message ?? `Sandbox runtime returned ${String(status)}.`,
                ),
              );
              return;
            }
            resolve(text);
          });
        },
      );
      req.on("timeout", () => {
        req.destroy(new Error("Sandbox runtime request timed out."));
      });
      req.on("error", (error) => {
        reject(new SandboxError("internal", "Cannot reach the sandbox runtime.", { cause: error }));
      });
      if (payload !== undefined) req.write(payload);
      req.end();
    });

    if (responseText.trim() === "") {
      throw new SandboxError("internal", "Sandbox runtime returned an empty body.");
    }
    try {
      return JSON.parse(responseText) as T;
    } catch (error) {
      throw new SandboxError("internal", "Sandbox runtime returned malformed JSON.", {
        cause: error,
      });
    }
  }
}

export interface RemoteSandboxOptions {
  readonly id: string;
  readonly isolation: "container" | "microvm";
  readonly runtime: SandboxRuntimeClient;
  readonly spec: SandboxSpec;
  readonly dispose: () => Promise<void>;
}

/**
 * `SandboxInstance` whose control plane is a runtime reachable over the network (Docker container or
 * microVM guest). Preview state is cached locally so callers can read it without an extra round trip.
 */
export function createRemoteSandboxInstance(options: RemoteSandboxOptions): SandboxInstance {
  const { runtime } = options;
  let latest: PreviewState = { phase: "idle", logs: [] };

  return {
    id: options.id,
    isolation: options.isolation,
    spec: options.spec,
    exec: (execOptions) => runtime.exec(execOptions),
    readFile: (path) => runtime.readFile(path),
    writeFile: (path, content) => runtime.writeFile(path, content),
    listFiles: (limit) => runtime.listFiles(limit),
    exists: (path) => runtime.exists(path),
    async startPreview(previewOptions) {
      latest = await runtime.startPreview(previewOptions);
      return latest;
    },
    preview: () => latest,
    async stopPreview() {
      latest = await runtime.stopPreview();
    },
    proxyPreview: (httpRequest) => runtime.proxyPreview(httpRequest),
    async stop() {
      await runtime.stopPreview().catch(() => undefined);
      await options.dispose();
    },
  };
}

export type { SandboxProvider };
