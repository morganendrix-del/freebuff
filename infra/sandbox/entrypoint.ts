/**
 * Sandbox runtime entrypoint. Binds on all interfaces inside the container so the orchestrator and
 * compose healthcheck can reach it. The image runs this as an unprivileged user with a read-only
 * root filesystem; nothing here executes user-provided code.
 */
import { handleSandboxRequest } from "./health";

const DEFAULT_PORT = 8788;

const port = Number.parseInt(process.env.SANDBOX_HTTP_PORT ?? String(DEFAULT_PORT), 10);
if (!Number.isInteger(port) || port <= 0 || port > 65_535) {
  throw new Error(`Invalid SANDBOX_HTTP_PORT: ${String(process.env.SANDBOX_HTTP_PORT)}`);
}

const server = Bun.serve({
  hostname: "0.0.0.0",
  port,
  fetch: handleSandboxRequest,
});

process.stdout.write(
  `${JSON.stringify({ event: "sandbox.ready", port: server.port, pid: process.pid })}\n`,
);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    void server.stop(true);
    process.stdout.write(`${JSON.stringify({ event: "sandbox.stopped", signal })}\n`);
  });
}
