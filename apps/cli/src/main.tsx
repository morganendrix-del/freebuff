#!/usr/bin/env bun
import type { LlmProvider } from "@freebuff/llm-providers";
import type { ProviderId } from "@freebuff/shared";

import { clientFromConfig } from "./api";
import { buildProgram } from "./commands";
import { ConfigStore } from "./config";
import { createCliProvider } from "./provider";
import { createCliStore } from "./state";

async function main(): Promise<void> {
  const store = new ConfigStore();
  const providerFactory = (providerId: ProviderId): LlmProvider => createCliProvider(providerId);

  const launchTui = async (): Promise<void> => {
    const client = clientFromConfig(store);
    const config = store.read();
    const authenticated = config.token !== undefined;

    const cliStore = createCliStore({
      phase: authenticated ? "picking_project" : "signed_out",
      projects: [],
      sessions: [],
      messages: [],
      streamingText: "",
      statusLine: authenticated ? "Loading projects…" : "Sign in to continue.",
      running: false,
    });

    let provider: LlmProvider | undefined;
    try {
      provider = providerFactory("deepseek");
    } catch {
      provider = undefined;
    }

    const { launchApp } = await import("./app");
    await launchApp({
      store: cliStore,
      configStore: store,
      client,
      projectRoot: process.cwd(),
      provider,
      authenticated,
    });
  };

  const program = buildProgram({
    store,
    cwd: process.cwd(),
    out: (line) => {
      process.stdout.write(`${line}\n`);
    },
    providerFactory,
    launchTui,
  });

  await program.parseAsync(process.argv);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`freebuff: ${message}\n`);
  process.exitCode = 1;
});
