import path from "node:path";

import { createLogger, loadEnv } from "@freebuff/shared";
import { DockerProvider, ProcessProvider, SandboxManager } from "@freebuff/sandbox-orchestrator";
import type { SandboxProvider } from "@freebuff/sandbox-orchestrator";

import { startCloudServer } from "./server";

/**
 * Cloud service: imports repositories, runs them in isolated sandboxes and serves their previews.
 *
 * Local development uses the process provider (no kernel boundary, `isolation: "process"`); CI and
 * production use the hardened container or microVM provider. The chosen provider is reported on
 * every sandbox record so the dashboard never overstates isolation.
 */
async function main(): Promise<void> {
  const env = loadEnv();
  const logger = createLogger({
    level: process.env.LOG_LEVEL === "debug" ? "debug" : "info",
  });

  const provider: SandboxProvider =
    env.SANDBOX_PROVIDER === "docker"
      ? new DockerProvider({ image: env.SANDBOX_IMAGE })
      : new ProcessProvider({ root: path.resolve(env.SANDBOX_ROOT) });

  let baseUrl = env.CLOUD_PUBLIC_URL ?? "";
  const manager = new SandboxManager({
    provider,
    logger,
    previewUrlFor: (sandboxId) => `${baseUrl.replace(/\/+$/, "")}/preview/${sandboxId}/`,
  });

  const server = await startCloudServer({
    manager,
    port: env.CLOUD_PORT,
    hostname: "0.0.0.0",
    logger,
    ...(env.CLOUD_API_TOKEN === undefined ? {} : { apiToken: env.CLOUD_API_TOKEN }),
  });

  baseUrl = env.CLOUD_PUBLIC_URL ?? server.url;
  logger.info("cloud ready", {
    url: server.url,
    provider: provider.name,
    isolation: provider.isolation,
    previewBase: baseUrl,
  });

  const reaper = setInterval(() => {
    void manager.reapExpired().then((stopped) => {
      if (stopped.length > 0) logger.info("expired sandboxes stopped", { count: stopped.length });
    });
  }, 30_000);
  reaper.unref();

  const shutdown = async (signal: string): Promise<void> => {
    logger.info("cloud stopping", { signal });
    clearInterval(reaper);
    await server.close().catch(() => undefined);
    for (const record of manager.list()) {
      if (record.status === "ready" || record.status === "starting") {
        await manager.stop(record.id).catch(() => undefined);
      }
    }
  };

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => {
      void shutdown(signal).then(() => {
        process.exit(0);
      });
    });
  }
}

await main();
