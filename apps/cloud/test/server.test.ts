import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import { ProcessProvider, SandboxManager } from "@freebuff/sandbox-orchestrator";
import type { SandboxRecord } from "@freebuff/sandbox-orchestrator";

import { createFixtureRepository } from "../../../tests/integration/sandbox/helpers";
import { startCloudServer } from "../src/server";
import type { CloudServer } from "../src/server";

const TOKEN = "cloud-test-token";
const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  while (cleanups.length > 0) {
    const task = cleanups.pop();
    if (task !== undefined) await task();
  }
});

interface Harness {
  readonly server: CloudServer;
  readonly manager: SandboxManager;
  readonly cloneUrl: string;
  authorized(path: string, init?: RequestInit): Promise<Response>;
}

async function harness(): Promise<Harness> {
  const fixture = await createFixtureRepository();
  cleanups.push(fixture.cleanup);

  const sandboxes = await mkdtemp(path.join(tmpdir(), "freebuff-cloud-sbx-"));
  cleanups.push(async () => {
    await rm(sandboxes, { recursive: true, force: true });
  });

  let baseUrl = "";
  const manager = new SandboxManager({
    provider: new ProcessProvider({ root: sandboxes }),
    previewUrlFor: (id) => `${baseUrl}/preview/${id}/`,
  });

  const server = await startCloudServer({ manager, apiToken: TOKEN, port: 0 });
  cleanups.push(async () => {
    await server.close();
  });
  baseUrl = server.url;

  return {
    server,
    manager,
    cloneUrl: fixture.cloneUrl,
    authorized: (route, init = {}) => {
      const headers = new Headers(init.headers);
      headers.set("authorization", `Bearer ${TOKEN}`);
      return fetch(`${server.url}${route}`, { ...init, headers });
    },
  };
}

async function waitUntilReady(current: Harness, id: string): Promise<SandboxRecord> {
  const deadline = Date.now() + 60_000;
  for (;;) {
    const response = await current.authorized(`/v1/sandboxes/${id}`);
    const payload = (await response.json()) as { sandbox: SandboxRecord };
    if (payload.sandbox.status === "ready" || payload.sandbox.status === "failed") {
      return payload.sandbox;
    }
    if (Date.now() > deadline) throw new Error("Sandbox did not settle.");
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

describe("cloud sandbox API", () => {
  test("requires the API token for every management route", async () => {
    const current = await harness();

    const withoutToken = await fetch(`${current.server.url}/v1/sandboxes`);
    expect(withoutToken.status).toBe(401);

    const wrongToken = await fetch(`${current.server.url}/v1/sandboxes`, {
      headers: { authorization: "Bearer wrong" },
    });
    expect(wrongToken.status).toBe(401);

    const health = await fetch(`${current.server.url}/health`);
    expect(health.status).toBe(200);
  });

  test("imports a repository over HTTP and serves its preview through the proxy", async () => {
    const current = await harness();

    const accepted = await current.authorized("/v1/sandboxes", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        repo: "acme/demo",
        cloneUrl: current.cloneUrl,
      }),
    });
    expect(accepted.status).toBe(202);
    const created = (await accepted.json()) as SandboxRecord;
    expect(created.id).toMatch(/^sandbox_[0-9a-f]{32}$/);
    expect(created.repo).toMatchObject({ owner: "acme", name: "demo" });

    const ready = await waitUntilReady(current, created.id);
    expect(ready.failure).toBeUndefined();
    expect(ready.status).toBe("ready");
    expect(ready.previewUrl).toBe(`${current.server.url}/preview/${created.id}/`);

    const preview = await fetch(`${current.server.url}/preview/${created.id}/`);
    expect(preview.status).toBe(200);
    expect(await preview.text()).toContain("freebuff preview ok");

    const proxiedPath = await fetch(`${current.server.url}/preview/${created.id}/deep/link?x=1`);
    expect(await proxiedPath.text()).toContain("/deep/link?x=1");

    const list = await current.authorized("/v1/sandboxes");
    const listed = (await list.json()) as { sandboxes: SandboxRecord[] };
    expect(listed.sandboxes.map((item) => item.id)).toContain(created.id);

    const stopped = await current.authorized(`/v1/sandboxes/${created.id}/stop`, {
      method: "POST",
    });
    expect(stopped.status).toBe(200);
    const afterStop = (await stopped.json()) as { sandbox: SandboxRecord };
    expect(afterStop.sandbox.status).toBe("stopped");

    const gone = await fetch(`${current.server.url}/preview/${created.id}/`);
    expect(gone.status).toBe(409);
  }, 120_000);

  test("serves the dashboard and validates import input", async () => {
    const current = await harness();

    const dashboard = await current.authorized("/");
    expect(dashboard.status).toBe(200);
    expect(dashboard.headers.get("content-type")).toContain("text/html");
    expect(await dashboard.text()).toContain("freebuff cloud");

    const invalid = await current.authorized("/v1/sandboxes", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ repo: "../escape" }),
    });
    expect(invalid.status).toBe(400);

    const missing = await current.authorized(
      "/v1/sandboxes/sandbox_00000000000000000000000000000000",
    );
    expect(missing.status).toBe(404);

    const malformed = await current.authorized("/v1/sandboxes", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{not json",
    });
    expect(malformed.status).toBe(400);
  });
});
