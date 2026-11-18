import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test, vi } from "vitest";

import {
  ConfigStore,
  anonClient,
  authenticatedClient,
  clientFromConfig,
  listProjects,
  resolveProject,
  runChatTurn,
  signIn,
  startLocalPlatform,
} from "@freebuff/cli";
import type { LocalPlatform } from "@freebuff/cli";

import {
  ScriptedProvider,
  completed,
  finalText,
  script,
  toolCall,
} from "../agent/scripted-provider";

const cleanup: (() => Promise<void>)[] = [];

afterEach(async () => {
  while (cleanup.length > 0) {
    const task = cleanup.pop();
    if (task !== undefined) await task();
  }
});

async function tempDir(prefix: string): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), prefix));
  cleanup.push(async () => {
    await rm(directory, { recursive: true, force: true });
  });
  return directory;
}

async function bootPlatform(storePath: string, port?: number): Promise<LocalPlatform> {
  const platform = await startLocalPlatform({
    storePath,
    countryCode: "US",
    timeZone: "UTC",
    ...(port === undefined ? {} : { port }),
  });
  cleanup.push(async () => {
    await platform.close();
  });
  return platform;
}

describe("CLI gate: auth → picker → multi-file edit → terminal → persistence", () => {
  test("one interactive turn exercises the whole path and survives a restart", async () => {
    const home = await tempDir("freebuff-cli-home-");
    const repo = await tempDir("freebuff-cli-repo-");
    await writeFile(path.join(repo, "a.ts"), "export const a = 0;\n", "utf8");
    await writeFile(path.join(repo, "b.ts"), "export const b = 0;\n", "utf8");

    const platform = await bootPlatform(path.join(home, "platform.json"));
    const store = new ConfigStore({ directory: home });
    store.write({ platformUrl: platform.url });

    // 1. Auth: the flow stores a token the platform issued.
    const signedIn = await signIn({
      store,
      client: anonClient(store),
      email: "dev@example.com",
    });
    expect(signedIn.user.email).toBe("dev@example.com");
    expect(store.read().token).toBeDefined();
    const client = authenticatedClient(store);
    expect((await client.auth.me()).id).toBe(signedIn.user.id);

    // 2. Picker: the repository registers once and is then listed for selection.
    expect(await listProjects(client)).toHaveLength(0);
    const project = await resolveProject({ client, rootPath: repo });
    const listed = await listProjects(client);
    expect(listed.map((entry) => entry.id)).toEqual([project.id]);
    expect(listed[0]?.rootPath).toBe(repo);

    // 3. Multi-file edit + 4. terminal command, through the real runtime and broker.
    const prompt = "Set both constants to 42 and prove the shell works";
    const stdoutSpy = vi.spyOn(process.stdout, "write");
    const provider = new ScriptedProvider([
      script(prompt, [
        ...toolCall(0, "call_a", "write_file", { path: "a.ts", content: "export const a = 42;\n" }),
        ...toolCall(1, "call_b", "write_file", { path: "b.ts", content: "export const b = 42;\n" }),
        ...toolCall(2, "call_sh", "run_command", { command: "printf broker-stdout-marker" }),
        completed("tool_use"),
      ]),
      script(prompt, finalText("Set a and b to 42 and ran the shell check.")),
    ]);

    const turn = await runChatTurn({
      client,
      projectRoot: repo,
      prompt,
      providerFactory: () => provider,
      limits: { maxSteps: 4 },
    });

    const written = stdoutSpy.mock.calls.map((call) => String(call[0])).join("");
    stdoutSpy.mockRestore();

    expect(await readFile(path.join(repo, "a.ts"), "utf8")).toBe("export const a = 42;\n");
    expect(await readFile(path.join(repo, "b.ts"), "utf8")).toBe("export const b = 42;\n");
    expect(turn.result.status).toBe("completed");

    const toolResults = turn.events.filter((event) => event.type === "tool_result");
    expect(toolResults).toHaveLength(3);
    expect(toolResults.every((event) => event.ok)).toBe(true);
    expect(
      turn.events.some((event) => event.type === "tool_result" && event.toolName === "run_command"),
    ).toBe(true);
    // The broker captured the shell output; it never reached the CLI's own stdio.
    expect(written).not.toContain("broker-stdout-marker");

    // 5. Persistence: the turn is stored server-side under the session.
    const stored = await client.sessions.get(turn.session.id);
    expect(stored.messages.length).toBeGreaterThanOrEqual(4);
    const assistantText = stored.messages
      .filter((message) => message.role === "assistant")
      .flatMap((message) => message.content)
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join(" ");
    expect(assistantText).toContain("Set a and b to 42");

    const quota = await client.quota.snapshot();
    expect(quota.windowsStartedToday).toBe(1);
    expect(quota.policy.countryCode).toBe("US");

    // Restart the platform on the same state file: history and auth survive.
    await platform.close();
    const restarted = await bootPlatform(platform.storePath, platform.port);
    store.write({ platformUrl: restarted.url });
    const clientAfterRestart = clientFromConfig(store);

    expect(clientAfterRestart.baseUrl).toBe(restarted.url);
    const sessions = await clientAfterRestart.sessions.list();
    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.id).toBe(turn.session.id);
    expect(sessions[0]?.messageCount).toBe(stored.messages.length);

    const history = await clientAfterRestart.sessions.get(turn.session.id);
    expect(history.messages).toHaveLength(stored.messages.length);
    expect(history.project.id).toBe(project.id);

    // The persisted project is still selectable after the restart.
    const projectsAfterRestart = await listProjects(clientAfterRestart);
    expect(projectsAfterRestart.map((entry) => entry.id)).toEqual([project.id]);
  });

  test("unauthenticated clients cannot read someone else's session", async () => {
    const home = await tempDir("freebuff-cli-iso-");
    const repo = await tempDir("freebuff-cli-iso-repo-");
    await writeFile(path.join(repo, "a.ts"), "export const a = 0;\n", "utf8");

    const platform = await bootPlatform(path.join(home, "platform.json"));
    const store = new ConfigStore({ directory: home });
    store.write({ platformUrl: platform.url });

    const first = await signIn({ store, client: anonClient(store), email: "one@example.com" });
    const firstClient = authenticatedClient(store);
    const project = await resolveProject({ client: firstClient, rootPath: repo });
    const session = await firstClient.sessions.create({
      projectId: project.id,
      surface: "cli",
      title: "private",
    });

    store.write({ token: undefined });
    await signIn({ store, client: anonClient(store), email: "two@example.com" });
    const secondClient = authenticatedClient(store);

    await expect(secondClient.sessions.get(session.id)).rejects.toMatchObject({ status: 404 });
    expect(await secondClient.sessions.list()).toHaveLength(0);
    expect(secondClient.baseUrl).toBe(platform.url);
    expect(first.user.id).not.toBe((await secondClient.auth.me()).id);
  });
});
