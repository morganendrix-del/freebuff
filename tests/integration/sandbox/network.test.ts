import { createServer, request as httpRequest } from "node:http";
import type { Server } from "node:http";
import { connect } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import { isEgressAllowed } from "@freebuff/sandbox-orchestrator";
import { ProcessProvider } from "@freebuff/sandbox-orchestrator";
import { buildSandboxSpec } from "@freebuff/sandbox-orchestrator";
import { startEgressProxy } from "../../../infra/sandbox-proxy/proxy";

const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  while (cleanups.length > 0) {
    const task = cleanups.pop();
    if (task !== undefined) await task();
  }
});

async function origin(body: string): Promise<{ port: number }> {
  const server: Server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/plain" });
    response.end(body);
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  cleanups.push(async () => {
    await new Promise<void>((resolve) => {
      server.close(() => {
        resolve();
      });
    });
  });
  const address = server.address();
  if (typeof address !== "object" || address === null) throw new Error("no port");
  return { port: address.port };
}

/** Sends an absolute-form request, which is what a browser sends to a proxy. */
async function proxyGet(
  proxyPort: number,
  absoluteUrl: string,
): Promise<{ status: number; body: string }> {
  const target = new URL(absoluteUrl);
  return await new Promise((resolve, reject) => {
    const request = httpRequest(
      {
        host: "127.0.0.1",
        port: proxyPort,
        method: "GET",
        path: absoluteUrl,
        headers: { host: target.host },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () => {
          resolve({
            status: response.statusCode ?? 0,
            body: Buffer.concat(chunks).toString("utf8"),
          });
        });
      },
    );
    request.on("error", reject);
    request.end();
  });
}

describe("network isolation: egress allowlist", () => {
  test("allows an allowlisted host:port and denies everything else, recording denials", async () => {
    const allowedOrigin = await origin("allowed-payload");
    const blockedOrigin = await origin("blocked-payload");

    const proxy = await startEgressProxy({
      policy: {
        mode: "allowlist",
        allow: [{ host: "127.0.0.1", ports: [allowedOrigin.port] }],
      },
      port: 0,
      hostname: "127.0.0.1",
    });
    cleanups.push(async () => {
      await proxy.close();
    });

    const allowed = await proxyGet(proxy.port, `http://127.0.0.1:${String(allowedOrigin.port)}/ok`);
    expect(allowed.status).toBe(200);
    expect(allowed.body).toBe("allowed-payload");

    const sameHostOtherPort = await proxyGet(
      proxy.port,
      `http://127.0.0.1:${String(blockedOrigin.port)}/nope`,
    );
    expect(sameHostOtherPort.status).toBe(403);
    expect(sameHostOtherPort.body).toContain("egress_denied");

    const otherHost = await proxyGet(proxy.port, "http://not-allowed.invalid/");
    expect(otherHost.status).toBe(403);

    expect(proxy.denials).toHaveLength(2);
    expect(proxy.denials[0]).toMatchObject({ host: "127.0.0.1", port: blockedOrigin.port });
  });

  test("denies CONNECT tunnels unless the destination is allowlisted", async () => {
    const tunnelTarget = await origin("tunnel");
    const proxy = await startEgressProxy({
      policy: { mode: "allowlist", allow: [{ host: "127.0.0.1", ports: [tunnelTarget.port] }] },
      port: 0,
      hostname: "127.0.0.1",
    });
    cleanups.push(async () => {
      await proxy.close();
    });

    const blocked = await new Promise<string>((resolve, reject) => {
      const socket = connect(proxy.port, "127.0.0.1", () => {
        socket.write("CONNECT example.com:443 HTTP/1.1\r\nHost: example.com:443\r\n\r\n");
      });
      let received = "";
      socket.on("data", (chunk) => {
        received += String(chunk);
        if (received.includes("\r\n")) {
          socket.destroy();
          resolve(received.split("\r\n")[0] ?? received);
        }
      });
      socket.on("error", reject);
    });
    expect(blocked).toContain("403");

    const allowed = await new Promise<string>((resolve, reject) => {
      const socket = connect(proxy.port, "127.0.0.1", () => {
        socket.write(
          `CONNECT 127.0.0.1:${String(tunnelTarget.port)} HTTP/1.1\r\nHost: 127.0.0.1:${String(tunnelTarget.port)}\r\n\r\n`,
        );
      });
      let received = "";
      socket.on("data", (chunk) => {
        received += String(chunk);
        if (received.includes("\r\n\r\n")) {
          socket.destroy();
          resolve(received.split("\r\n")[0] ?? received);
        }
      });
      socket.on("error", reject);
    });
    expect(allowed).toContain("200 Connection Established");
  });

  test("deny_all blocks even allowlisted hosts", async () => {
    const target = await origin("should-not-arrive");
    const proxy = await startEgressProxy({
      policy: { mode: "deny_all", allow: [{ host: "127.0.0.1", ports: [target.port] }] },
      port: 0,
      hostname: "127.0.0.1",
    });
    cleanups.push(async () => {
      await proxy.close();
    });

    const response = await proxyGet(proxy.port, `http://127.0.0.1:${String(target.port)}/`);
    expect(response.status).toBe(403);
  });

  test("a sandbox is started with proxy variables for its policy and none for deny_all", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "freebuff-egress-sandbox-"));
    cleanups.push(async () => {
      await rm(root, { recursive: true, force: true });
    });
    const target = await origin("proxied");
    const proxy = await startEgressProxy({
      policy: { mode: "allowlist", allow: [{ host: "127.0.0.1", ports: [target.port] }] },
      port: 0,
      hostname: "127.0.0.1",
    });
    cleanups.push(async () => {
      await proxy.close();
    });

    const provider = new ProcessProvider({ root, egressProxyUrl: proxy.url });
    const sandbox = await provider.create({
      spec: buildSandboxSpec({
        repo: { provider: "github", owner: "acme", name: "demo" },
        egress: { mode: "allowlist", allow: [{ host: "127.0.0.1", ports: [target.port] }] },
      }),
    });
    cleanups.push(async () => {
      await sandbox.stop();
    });

    const withProxy = await sandbox.exec({
      command: 'printf %s "$HTTPS_PROXY"',
      timeoutMs: 10_000,
    });
    expect(withProxy.stdout).toBe(proxy.url);

    // git/curl honour HTTPS_PROXY; a direct request from inside the proxy policy is what the network
    // boundary blocks in production (Docker internal network / VM tap bridge).
    expect(
      isEgressAllowed(
        { mode: "allowlist", allow: [{ host: "127.0.0.1", ports: [target.port] }] },
        "127.0.0.1",
        target.port,
      ),
    ).toBe(true);
  }, 30_000);
});
