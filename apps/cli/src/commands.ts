import { Command } from "commander";
import type { LlmProvider } from "@freebuff/llm-providers";
import type { ProviderId } from "@freebuff/shared";
import { resolveModelForTier } from "@freebuff/shared";

import { anonClient, authenticatedClient, clientFromConfig } from "./api";
import type { ConfigStore } from "./config";
import { runChatTurn } from "./flows/chat";
import { signIn } from "./flows/login";
import { startLocalPlatform } from "./platform/server";

export interface CommandDeps {
  readonly store: ConfigStore;
  readonly cwd: string;
  readonly out: (line: string) => void;
  readonly providerFactory: (providerId: ProviderId) => LlmProvider;
  readonly launchTui: () => Promise<void>;
}

/** Commander program for the CLI. The TUI is the default action; everything else is scriptable. */
export function buildProgram(deps: CommandDeps): Command {
  const program = new Command();
  program
    .name("freebuff")
    .description("Ad-supported AI coding agent for your terminal")
    .version("0.1.0");

  program
    .command("login")
    .argument("<email>", "account email")
    .description("sign in and store a platform token")
    .action(async (email: string) => {
      const result = await signIn({ store: deps.store, email, client: anonClient(deps.store) });
      deps.out(
        `${result.isNewUser ? "Created" : "Signed in to"} ${result.user.email} (${result.user.tier})`,
      );
      deps.out(`Platform: ${deps.store.read().platformUrl}`);
    });

  program
    .command("whoami")
    .description("show the signed-in account")
    .action(async () => {
      const user = await authenticatedClient(deps.store).auth.me();
      deps.out(`${user.email} · ${user.tier} · ${user.countryCode} · ${user.timeZone}`);
    });

  program
    .command("projects")
    .description("list projects registered for this account")
    .action(async () => {
      const projects = await authenticatedClient(deps.store).projects.list();
      if (projects.length === 0) deps.out("No projects yet. Run an edit in a repository first.");
      for (const project of projects) deps.out(`${project.name}\t${project.rootPath}`);
    });

  program
    .command("history")
    .description("list recent chat sessions")
    .action(async () => {
      const sessions = await authenticatedClient(deps.store).sessions.list();
      for (const session of sessions) {
        deps.out(
          `${session.id}\t${session.title}\t${String(session.messageCount)} message(s)\t${session.updatedAt}`,
        );
      }
    });

  program
    .command("ask")
    .argument("<prompt...>", "what the agent should do")
    .option("--model <id>", "model id to request")
    .option("--session <id>", "continue an existing session")
    .description("run one agent turn headlessly")
    .action(
      async (promptParts: readonly string[], options: { model?: string; session?: string }) => {
        const client = authenticatedClient(deps.store);
        const selection = resolveModelForTier("free", options.model);
        if (!selection.ok) throw new Error(selection.error.message);

        const result = await runChatTurn({
          client,
          projectRoot: deps.cwd,
          prompt: promptParts.join(" "),
          provider: deps.providerFactory(selection.value.provider),
          ...(options.model === undefined ? {} : { modelId: options.model }),
          ...(options.session === undefined ? {} : { sessionId: options.session as never }),
          onEvent: (event) => {
            if (event.type === "tool_call") {
              deps.out(`▶ ${event.toolName}`);
            }
            if (event.type === "tool_result") {
              deps.out(`${event.ok ? "✓" : "✗"} ${event.summary}`);
            }
          },
        });

        const text = result.result.messages
          .filter((message) => message.role === "assistant")
          .flatMap((message) => message.content)
          .filter((block) => block.type === "text")
          .map((block) => block.text)
          .join("\n");
        if (text !== "") deps.out(text);
        deps.out(`session ${result.session.id} · ${result.result.status}`);
      },
    );

  program
    .command("dev")
    .option("--port <port>", "port to listen on", "8788")
    .description("run the local platform API the CLI talks to")
    .action(async (options: { port: string }) => {
      const platform = await startLocalPlatform({ port: Number.parseInt(options.port, 10) });
      deps.store.write({ platformUrl: platform.url });
      deps.out(`Local platform listening on ${platform.url}`);
      deps.out(`State file: ${platform.storePath}`);
      deps.out("Stored config now points at this server.");
      await new Promise<void>((resolve) => {
        const shutdown = (): void => {
          resolve();
        };
        process.once("SIGINT", shutdown);
        process.once("SIGTERM", shutdown);
      });
      await platform.close();
    });

  program
    .command("config", { isDefault: false })
    .description("print the stored configuration")
    .action(() => {
      const config = deps.store.read();
      deps.out(`platform: ${config.platformUrl}`);
      deps.out(`email: ${config.email ?? "(none)"}`);
      deps.out(`token: ${config.token === undefined ? "(none)" : "(stored)"}`);
    });

  program.action(async () => {
    await deps.launchTui();
  });

  return program;
}

export function currentClient(store: ConfigStore): ReturnType<typeof clientFromConfig> {
  return clientFromConfig(store);
}
