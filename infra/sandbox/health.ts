/**
 * Readiness surface for the sandbox runtime.
 *
 * Phase 0 exposes liveness/identity only. Execution endpoints arrive with
 * packages/sandbox-orchestrator in Phase 3, so there is no half-built code path that can run
 * untrusted input.
 */

export interface SandboxInfo {
  readonly service: "freebuff-sandbox";
  readonly status: "ready";
  readonly sandboxId: string;
  readonly runtime: string;
  readonly uid: number;
  readonly egressMode: string;
  readonly workspace: string;
}

const DEFAULT_EGRESS_MODE = "allowlist";

export function sandboxInfo(): SandboxInfo {
  const bun = (globalThis as { Bun?: { version: string } }).Bun;
  return {
    service: "freebuff-sandbox",
    status: "ready",
    sandboxId: process.env.SANDBOX_ID ?? "local",
    runtime: bun === undefined ? `node ${process.version}` : `bun ${bun.version}`,
    uid: process.getuid?.() ?? -1,
    egressMode: process.env.SANDBOX_EGRESS_MODE ?? DEFAULT_EGRESS_MODE,
    workspace: process.cwd(),
  };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

export function handleSandboxRequest(request: Request): Response {
  const { pathname } = new URL(request.url);

  if (request.method !== "GET") {
    return json({ error: { code: "method_not_allowed", message: "Only GET is supported." } }, 405);
  }

  if (pathname === "/health") {
    return json({ status: "ok" });
  }

  if (pathname === "/info") {
    return json(sandboxInfo());
  }

  return json({ error: { code: "not_found", message: "Unknown sandbox endpoint." } }, 404);
}
