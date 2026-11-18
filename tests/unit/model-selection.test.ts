import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

import { describe, expect, test } from "vitest";

/**
 * Gate proof: no source file outside the catalogue names a model. Selection must flow through
 * `resolveModelForTier`; the ESLint rule `freebuff/no-hardcoded-model` enforces the same thing in CI.
 */
const MODEL_ID_PATTERN = /^(?:deepseek|claude|gpt)-[a-z0-9._-]+$/i;

async function* walk(directory: string): AsyncGenerator<string> {
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === "dist") continue;
      yield* walk(absolute);
      continue;
    }
    yield absolute;
  }
}

describe("model selection is centralised", () => {
  test("no implemented source file hardcodes a model id outside the catalogue", async () => {
    const violations: string[] = [];
    const root = path.join(process.cwd(), "packages");

    for await (const file of walk(root)) {
      if (!file.endsWith(".ts") || file.endsWith(".test.ts")) continue;
      if (!file.includes(`${path.sep}src${path.sep}`)) continue;
      if (file.endsWith(path.join("config", "models.ts"))) continue;

      const source = await readFile(file, "utf8");
      for (const match of source.matchAll(/"([^"\n]{1,64})"/g)) {
        const candidate = match[1] ?? "";
        if (MODEL_ID_PATTERN.test(candidate)) {
          violations.push(`${path.relative(process.cwd(), file)}: ${candidate}`);
        }
      }
    }

    expect(violations).toEqual([]);
  });

  test("the catalogue is the only module that resolves a tier to a model", async () => {
    const source = await readFile(
      path.join(process.cwd(), "packages", "shared", "src", "config", "models.ts"),
      "utf8",
    );

    expect(source).toContain("export function resolveModelForTier");
    expect(source).toContain("DEFAULT_TIER_MODEL_POLICY");
  });
});
