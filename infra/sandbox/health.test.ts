import { describe, expect, test } from "vitest";

import { handleSandboxRequest, sandboxInfo } from "./health";

const get = (path: string, method = "GET") =>
  handleSandboxRequest(new Request(`http://sandbox.local${path}`, { method }));

describe("sandbox readiness surface", () => {
  test("reports healthy", async () => {
    const response = get("/health");
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ status: "ok" });
  });

  test("reports identity and isolation posture", async () => {
    const info = sandboxInfo();
    expect(info.service).toBe("freebuff-sandbox");
    expect(info.egressMode).toBeTypeOf("string");
    expect(info.workspace).toBeTypeOf("string");

    const response = get("/info");
    expect(response.headers.get("cache-control")).toBe("no-store");
    await expect(response.json()).resolves.toMatchObject({ status: "ready" });
  });

  test("rejects non-GET requests", () => {
    expect(get("/health", "POST").status).toBe(405);
  });

  test("returns 404 for unknown routes", async () => {
    const response = get("/exec");
    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({ error: { code: "not_found" } });
  });
});
