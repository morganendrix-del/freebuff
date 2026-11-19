import { createSandboxRuntime } from "./index";

/**
 * Sandbox runtime process. Runs inside the container/microVM image (and locally for development).
 * Binds every interface inside the container so the orchestrator can reach the control API; the host
 * only publishes loopback ports.
 */

const DEFAULT_PORT = 8788;

function parsePort(): number {
  const raw = process.env.SANDBOX_HTTP_PORT ?? String(DEFAULT_PORT);
  const port = Number.parseInt(raw, 10);
  if (!Number.isInteger(port) || port <= 0 || port > 65_535) {
    throw new Error(`Invalid SANDBOX_HTTP_PORT: ${raw}`);
  }
  return port;
}

const port = parsePort();
const token = process.env.SANDBOX_TOKEN;
const workspace = process.env.SANDBOX_WORKSPACE ?? "/workspace";
const egressMode = process.env.SANDBOX_EGRESS_MODE ?? "allowlist";

if (egressMode !== "allowlist" && egressMode !== "deny_all" && egressMode !== "open") {
  throw new Error(`Invalid SANDBOX_EGRESS_MODE: ${egressMode}`);
}

const runtime = await createSandboxRuntime({
  workspace,
  sandboxId: process.env.SANDBOX_ID ?? "local",
  egressMode,
  isolation: process.env.SANDBOX_ISOLATION === "microvm" ? "microvm" : "container",
  ...(token === undefined || token === "" ? {} : { token }),
});

const server = Bun.serve({
  hostname: "0.0.0.0",
  port,
  idleTimeout: 120,
  fetch: (request) => runtime.handle(request),
});

process.stdout.write(
  `${JSON.stringify({ event: "sandbox.ready", port: server.port, pid: process.pid, sandboxId: runtime.sandboxId })}\n`,
);

const shutdown = async (signal: string): Promise<void> => {
  await runtime.release().catch(() => undefined);
  await server.stop(true);
  process.stdout.write(`${JSON.stringify({ event: "sandbox.stopped", signal })}\n`);
};

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    void shutdown(signal);
  });
}
