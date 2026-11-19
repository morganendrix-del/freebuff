import { request as httpRequest } from "node:http";

import type { SandboxSpec } from "@freebuff/shared";

import { SandboxError } from "./errors";
import type { ExecOptions, SandboxInstance } from "./provider";
import { assertPreviewPort } from "./preview";
import type { PreviewStartOptions, PreviewState } from "./preview";
import type { RunResult } from "./exec";

export interface RuntimeClientOptions {
  /** TCP origin for a runtime reachable over loopback (development, published tests). */
  readonly origin?: string;
  /** Unix socket for a runtime whose control channel is a mounted socket (containers, microVMs). */
  readonly socketPath?: string;
  readonly token?: string;
  readonly timeoutMs?: number;
}

interface RuntimeErrorBody {
  readonly error?: { readonly code?: string; readonly message?: string };
}

const DEFAULT_TIMEOUT_MS = 30_000;

interface RawResponse {
  readonly status: number;
  readonly body: Buffer;
  headers(): Headers;
}

/**
 * HTTP client for the sandbox runtime control API (`packages/sandbox-orchestrator/src/runtime`).
 *
 * Supports two transports: a loopback origin (development, port-published tests) and a Unix socket
 * (containers and microVMs). The socket is the production path for containers because Docker does not
 * publish ports on an internal network — and a control channel that never enters the network stack is
 * a smaller surface anyway.
 */
export class SandboxRuntimeClient {
  readonly #origin: string | undefined;
  readonly #socketPath: string | undefined;
  readonly #token: string | undefined;
  readonly #timeoutMs: number;

  constructor(options: RuntimeClientOptions) {
    if ((options.origin === undefined) === (options.socketPath === undefined)) {
      throw new SandboxError(
        "invalid_config",
        "A sandbox runtime client needs exactly one of: origin, socketPath.",
      );
    }
    this.#origin = options.origin?.replace(/\/+$/, "");
    this.#socketPath = options.socketPath;
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
    const path = `/preview/proxy${incoming.pathname}${incoming.search}`;
    const headers = new Headers(request.headers);
    headers.delete("host");
    headers.delete("connection");
    if (this.#token !== undefined) headers.set("authorization", `Bearer ${this.#token}`);

    const hasBody = request.method !== "GET" && request.method !== "HEAD";
    const body = hasBody ? Buffer.from(await request.arrayBuffer()) : undefined;

    const response = await this.#send(request.method, path, body, headers, 30_000);
    const outputHeaders = new Headers(response.headers());
    return new Response(new Uint8Array(response.body), {
      status: response.status,
      headers: outputHeaders,
    });
  }

  async #json<T>(
    method: "GET" | "POST",
    path: string,
    body?: unknown,
    timeoutMs?: number,
  ): Promise<T> {
    const headers = new Headers({ accept: "application/json" });
    if (this.#token !== undefined) headers.set("authorization", `Bearer ${this.#token}`);
    const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
    if (payload !== undefined) headers.set("content-type", "application/json");

    const response = await this.#send(method, path, payload, headers, timeoutMs);
    const text = response.body.toString("utf8");

    if (response.status >= 400) {
      let parsed: RuntimeErrorBody = {};
      try {
        parsed = JSON.parse(text) as RuntimeErrorBody;
      } catch {
        // Non-JSON error body: fall through to the status-based message.
      }
      throw new SandboxError(
        "internal",
        parsed.error?.message ?? `Sandbox runtime returned ${String(response.status)}.`,
      );
    }

    if (text.trim() === "") {
      throw new SandboxError("internal", "Sandbox runtime returned an empty body.");
    }
    try {
      return JSON.parse(text) as T;
    } catch (error) {
      throw new SandboxError("internal", "Sandbox runtime returned malformed JSON.", {
        cause: error,
      });
    }
  }

  async #send(
    method: string,
    path: string,
    body: Buffer | undefined,
    headers: Headers,
    timeoutMs?: number,
  ): Promise<RawResponse> {
    if (this.#origin !== undefined) {
      return await this.#sendOverHttp(this.#origin, method, path, body, headers, timeoutMs);
    }
    return await this.#sendOverSocket(path, method, body, headers, timeoutMs);
  }

  async #sendOverHttp(
    origin: string,
    method: string,
    path: string,
    body: Buffer | undefined,
    headers: Headers,
    timeoutMs?: number,
  ): Promise<RawResponse> {
    const timeout = timeoutMs ?? this.#timeoutMs;
    try {
      const response = await fetch(`${origin}${path}`, {
        method,
        headers,
        redirect: "manual",
        signal: AbortSignal.timeout(timeout),
        ...(body === undefined ? {} : { body: new Uint8Array(body) }),
      });
      return {
        status: response.status,
        body: Buffer.from(await response.arrayBuffer()),
        headers: () => new Headers(response.headers),
      };
    } catch (error) {
      throw new SandboxError("internal", "Cannot reach the sandbox runtime.", { cause: error });
    }
  }

  async #sendOverSocket(
    path: string,
    method: string,
    body: Buffer | undefined,
    headers: Headers,
    timeoutMs?: number,
  ): Promise<RawResponse> {
    const socketPath = this.#socketPath;
    if (socketPath === undefined) {
      throw new SandboxError("internal", "No sandbox runtime transport is configured.");
    }

    const flatHeaders: Record<string, string> = {};
    headers.forEach((value, name) => {
      flatHeaders[name] = value;
    });
    if (body !== undefined) flatHeaders["content-length"] = String(body.length);

    return await new Promise<RawResponse>((resolve, reject) => {
      const req = httpRequest(
        { socketPath, path, method, headers: flatHeaders, timeout: timeoutMs ?? this.#timeoutMs },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (chunk: Buffer) => chunks.push(chunk));
          res.on("end", () => {
            const responseHeaders = new Headers();
            for (const [name, value] of Object.entries(res.headers)) {
              if (value === undefined) continue;
              responseHeaders.set(name, Array.isArray(value) ? value.join(", ") : value);
            }
            resolve({
              status: res.statusCode ?? 0,
              body: Buffer.concat(chunks),
              headers: () => responseHeaders,
            });
          });
        },
      );
      req.on("timeout", () => {
        req.destroy(new Error("Sandbox runtime request timed out."));
      });
      req.on("error", (error) => {
        reject(
          new SandboxError("internal", "Cannot reach the sandbox runtime socket.", {
            cause: error,
          }),
        );
      });
      if (body !== undefined) req.write(body);
      req.end();
    });
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
 * `SandboxInstance` whose control plane is a runtime reachable over a socket or loopback port.
 * Preview state is cached locally so callers can read it without an extra round trip.
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
    proxyPreview: (httpRequestInit) => runtime.proxyPreview(httpRequestInit),
    async stop() {
      await runtime.stopPreview().catch(() => undefined);
      await options.dispose();
    },
  };
}
