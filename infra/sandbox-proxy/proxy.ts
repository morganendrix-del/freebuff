import { request as httpRequest, createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { connect } from "node:net";

import type { EgressPolicy } from "@freebuff/shared";
import { isEgressAllowed } from "../../packages/sandbox-orchestrator/src/egress.ts";

/**
 * Egress allowlist proxy.
 *
 * Sandboxes sit on an internal Docker network with no default route; the only way out is this proxy,
 * which answers plain HTTP (`GET http://host/path`), HTTPS (`CONNECT host:443`) and nothing else.
 * Hosts outside the policy get a 403 and are recorded. This is the enforcement point for
 * `EgressPolicy` on the container path; microVMs use the same policy on the host bridge.
 */

export interface DeniedRequest {
  readonly host: string;
  readonly port: number;
  readonly at: string;
}

export interface EgressProxyOptions {
  readonly policy: EgressPolicy;
  readonly port?: number;
  readonly hostname?: string;
  readonly onDenied?: (denial: DeniedRequest) => void;
}

export interface EgressProxy {
  readonly port: number;
  readonly url: string;
  readonly denials: readonly DeniedRequest[];
  close(): Promise<void>;
}

const PROXY_HEADER = "proxy-connection";

function deny(
  response: ServerResponse | { end(data: string): void },
  host: string,
  port: number,
): void {
  const body = JSON.stringify({
    error: { code: "egress_denied", message: `${host}:${String(port)} is not allowed.` },
  });
  if ("writeHead" in response) {
    response.writeHead(403, {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    });
    response.end(body);
    return;
  }
  response.end(`HTTP/1.1 403 Forbidden\r\ncontent-type: application/json\r\n\r\n${body}`);
}

function stripProxyHeaders(headers: IncomingMessage["headers"]): Record<string, string> {
  const output: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    if (name.toLowerCase() === PROXY_HEADER) continue;
    output[name] = Array.isArray(value) ? value.join(", ") : value;
  }
  return output;
}

function parseHostPort(
  value: string,
  fallbackPort: number,
): { host: string; port: number } | undefined {
  const trimmed = value.trim();
  const match = /^(?:\[([0-9a-fA-F:]+)\]|([^:]+))(?::(\d{1,5}))?$/.exec(trimmed);
  if (match === null) return undefined;
  const host = match[1] ?? match[2];
  if (host === undefined || host === "") return undefined;
  const port = match[3] === undefined ? fallbackPort : Number.parseInt(match[3], 10);
  if (!Number.isInteger(port) || port <= 0 || port > 65_535) return undefined;
  return { host, port };
}

export async function startEgressProxy(options: EgressProxyOptions): Promise<EgressProxy> {
  const denials: DeniedRequest[] = [];

  const record = (host: string, port: number): void => {
    const denial: DeniedRequest = { host, port, at: new Date().toISOString() };
    denials.push(denial);
    options.onDenied?.(denial);
  };

  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    let target: URL;
    try {
      target = new URL(request.url ?? "");
    } catch {
      response.writeHead(400, { "content-type": "application/json" });
      response.end(
        JSON.stringify({ error: { code: "invalid_request", message: "Absolute URL required." } }),
      );
      return;
    }

    const port =
      target.port === "" ? (target.protocol === "https:" ? 443 : 80) : Number(target.port);
    const host = target.hostname;

    if (!isEgressAllowed(options.policy, host, port)) {
      record(host, port);
      deny(response, host, port);
      return;
    }

    const upstream = httpRequest(
      {
        hostname: host,
        port,
        path: `${target.pathname}${target.search}`,
        method: request.method,
        headers: stripProxyHeaders(request.headers),
      },
      (upstreamResponse) => {
        response.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers);
        upstreamResponse.pipe(response);
      },
    );
    upstream.on("error", () => {
      if (!response.headersSent) {
        response.writeHead(502, { "content-type": "application/json" });
        response.end(
          JSON.stringify({ error: { code: "bad_gateway", message: "Upstream request failed." } }),
        );
      } else {
        response.end();
      }
    });
    request.pipe(upstream);
  });

  server.on("connect", (request: IncomingMessage, socket, head) => {
    const parsed = parseHostPort(request.url ?? "", 443);
    if (parsed === undefined) {
      socket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
      return;
    }

    if (!isEgressAllowed(options.policy, parsed.host, parsed.port)) {
      record(parsed.host, parsed.port);
      deny(socket, parsed.host, parsed.port);
      return;
    }

    const upstream = connect(parsed.port, parsed.host, () => {
      socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length > 0) upstream.write(head);
      upstream.pipe(socket);
      socket.pipe(upstream);
    });

    upstream.on("error", () => {
      socket.end("HTTP/1.1 502 Bad Gateway\r\n\r\n");
    });
    socket.on("error", () => {
      upstream.destroy();
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 0, options.hostname ?? "0.0.0.0", () => {
      server.removeListener("error", reject);
      resolve();
    });
  });

  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : (options.port ?? 0);

  return {
    port,
    url: `http://127.0.0.1:${String(port)}`,
    denials,
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
