import { readdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type { LlmProvider, ProviderEvent } from "@freebuff/llm-providers";
import { resolveModelForTier } from "@freebuff/shared";
import type { ProviderId } from "@freebuff/shared";
import { afterEach, describe, expect, test } from "vitest";

import {
  ConfigStore,
  anonClient,
  authenticatedClient,
  runChatTurn,
  signIn,
  startLocalPlatform,
} from "@freebuff/cli";

import { ScriptedProvider, finalText, script } from "../agent/scripted-provider";

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

async function setup() {
  const home = await tempDir("freebuff-provider-home-");
  const repo = await tempDir("freebuff-provider-repo-");
  const platform = await startLocalPlatform({ storePath: path.join(home, "platform.json") });
  cleanup.push(async () => {
    await platform.close();
  });

  const store = new ConfigStore({ directory: home });
  store.write({ platformUrl: platform.url });
  await signIn({ store, client: anonClient(store), email: "dev@example.com" });
  return { client: authenticatedClient(store), repo };
}

describe("provider selection follows the resolved model", () => {
  test("asks the factory for the resolved model's provider, not a fixed one", async () => {
    const { client, repo } = await setup();
    const prompt = "Say hello";
    const provider = new ScriptedProvider([script(prompt, finalText("hello"))]);
    const requested: ProviderId[] = [];

    const turn = await runChatTurn({
      client,
      projectRoot: repo,
      prompt,
      providerFactory: (providerId) => {
        requested.push(providerId);
        return provider;
      },
    });

    const expected = resolveModelForTier("free");
    if (!expected.ok) throw new Error(expected.error.message);

    expect(requested).toEqual([expected.value.provider]);
    expect(turn.model.id).toBe(expected.value.id);
    expect(turn.model.provider).toBe(expected.value.provider);
    expect(provider.calls).toHaveLength(1);
    expect(provider.calls[0]?.model.id).toBe(expected.value.id);
    expect(provider.calls[0]?.model.provider).toBe(expected.value.provider);
  });

  test("rejects a provider that cannot serve the resolved model", async () => {
    const { client, repo } = await setup();
    const prompt = "Say hello";
    const stream = async function* (): AsyncGenerator<ProviderEvent> {
      yield { type: "completed", stopReason: "end_turn" };
    };
    const wrongProvider: LlmProvider = { id: "openai", stream };

    await expect(
      runChatTurn({
        client,
        projectRoot: repo,
        prompt,
        providerFactory: () => wrongProvider,
      }),
    ).rejects.toThrow(/cannot serve model/u);
  });

  test("no CLI source hardcodes a provider id when building one", async () => {
    const root = path.resolve(import.meta.dirname, "../../../apps/cli/src");
    const files = await collectSources(root);
    const offenders: string[] = [];

    for (const file of files) {
      if (file.endsWith(".test.ts") || file.endsWith(".test.tsx")) continue;
      const source = await readFile(file, "utf8");
      if (/providerFactory\(\s*"(?!)/u.test(source))
        offenders.push(`${file}: providerFactory("…")`);
      for (const literal of ['"deepseek"', '"openai"', '"anthropic"']) {
        if (source.includes(literal)) offenders.push(`${file}: ${literal}`);
      }
    }

    expect(offenders).toEqual([]);
  });
});

async function collectSources(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await collectSources(absolute)));
      continue;
    }
    if (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx")) files.push(absolute);
  }
  return files;
}
