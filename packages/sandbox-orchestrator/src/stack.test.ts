import { describe, expect, test } from "vitest";

import { detectStack, portFromCommand } from "./stack";
import type { StackFiles } from "./stack";

function files(entries: Record<string, string>): StackFiles {
  return {
    async exists(candidate) {
      return candidate in entries;
    },
    async read(candidate) {
      return entries[candidate] ?? "";
    },
  };
}

describe("stack detection", () => {
  test("detects bun projects and their dev script", async () => {
    const stack = await detectStack(
      files({
        "package.json": JSON.stringify({ scripts: { dev: "vite --port 4173" } }),
        "bun.lock": "",
      }),
    );

    expect(stack).toMatchObject({
      stack: "bun",
      packageManager: "bun",
      installCommand: "bun install",
      devCommand: "vite --port 4173",
      previewPort: 4173,
    });
  });

  test("falls back to npm and prefers dev over start", async () => {
    const stack = await detectStack(
      files({
        "package.json": JSON.stringify({
          scripts: { start: "node server.js", dev: "node app.js" },
        }),
      }),
    );

    expect(stack.stack).toBe("node");
    expect(stack.packageManager).toBe("npm");
    expect(stack.installCommand).toContain("npm install");
    expect(stack.devCommand).toBe("node app.js");
    expect(stack.previewPort).toBeUndefined();
  });

  test("detects lockfile-specific package managers", async () => {
    const pnpm = await detectStack(files({ "package.json": "{}", "pnpm-lock.yaml": "" }));
    expect(pnpm.packageManager).toBe("pnpm");
    expect(pnpm.installCommand).toBe("pnpm install");

    const yarn = await detectStack(files({ "package.json": "{}", "yarn.lock": "" }));
    expect(yarn.packageManager).toBe("yarn");
  });

  test("detects non-JavaScript stacks", async () => {
    await expect(detectStack(files({ "go.mod": "module demo" }))).resolves.toMatchObject({
      stack: "go",
      installCommand: "go mod download",
    });
    await expect(detectStack(files({ "Cargo.toml": "[package]" }))).resolves.toMatchObject({
      stack: "rust",
    });
    await expect(detectStack(files({ "requirements.txt": "flask==3" }))).resolves.toMatchObject({
      stack: "python",
      packageManager: "pip",
    });
  });

  test("returns unknown for a tree it does not recognise", async () => {
    await expect(detectStack(files({ "README.md": "# hi" }))).resolves.toEqual({
      stack: "unknown",
    });
  });

  test("reads explicit ports only", () => {
    expect(portFromCommand("vite --port 5173")).toBe(5173);
    expect(portFromCommand("next dev -p 3001")).toBe(3001);
    expect(portFromCommand("vite")).toBeUndefined();
  });
});
