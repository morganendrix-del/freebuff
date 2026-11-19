import { createSandboxRuntime } from "./index";

/**
 * Sandbox runtime process. Runs inside the container/microVM image (and locally for development).
 *
 * Two transports: a TCP port on 0.0.0.0 for local runs and the image smoke test, and a Unix socket
 * for containers/microVMs — Docker does not publish ports on an internal network, and a socket keeps
 * the control API off the network stack entirely.
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
const controlSocket = process.env.SANDBOX_CONTROL_SOCKET ?? "";

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

const fetchHandler = (request: Request): Promise<Response> => runtime.handle(request);

let stopServer: (force: boolean) => Promise<void>;
let listening: Record<string, unknown>;

if (controlSocket === "") {
  const server = Bun.serve({
    hostname: "0.0.0.0",
    port,
    idleTimeout: 120,
    fetch: fetchHandler,
  });
  stopServer = (force) => server.stop(force);
  listening = { port: server.port };
} else {
  const server = Bun.serve({
    unix: controlSocket,
    fetch: fetchHandler,
  });
  stopServer = (force) => server.stop(force);
  listening = { socket: controlSocket };
}

process.stdout.write(
  `${JSON.stringify({
    event: "sandbox.ready",
    ...listening,
    pid: process.pid,
    sandboxId: runtime.sandboxId,
  })}\n`,
);

const shutdown = async (signal: string): Promise<void> => {
  await runtime.release().catch(() => undefined);
  await stopServer(true);
  process.stdout.write(`${JSON.stringify({ event: "sandbox.stopped", signal })}\n`);
};

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    void shutdown(signal);
  });
}
