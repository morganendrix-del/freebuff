import { describe, expect, test } from "vitest";

import { SandboxError } from "./errors";
import { buildCloneCommand, cloneUrlFor } from "./import";

describe("repository import", () => {
  test("builds the GitHub clone URL from owner and name", () => {
    expect(cloneUrlFor({ provider: "github", owner: "acme", name: "demo" })).toBe(
      "https://github.com/acme/demo.git",
    );
    expect(cloneUrlFor({ provider: "github", owner: "acme", name: "demo.git" })).toBe(
      "https://github.com/acme/demo.git",
    );
  });

  test("rejects owners and names that could escape the URL", () => {
    expect(() => cloneUrlFor({ provider: "github", owner: "acme/../evil", name: "demo" })).toThrow(
      SandboxError,
    );
    expect(() => cloneUrlFor({ provider: "github", owner: "acme", name: ".." })).toThrow(
      SandboxError,
    );
  });

  test("passes the token through git config environment variables, never argv", () => {
    const { command, env } = buildCloneCommand({
      url: "https://github.com/acme/private.git",
      branch: "release/1.0",
      token: "ghs_secret",
    });

    expect(command).toContain("git clone --depth 1 --single-branch");
    expect(command).toContain("--branch 'release/1.0'");
    expect(command).toContain("'https://github.com/acme/private.git' .");
    expect(command).not.toContain("ghs_secret");

    expect(env.GIT_CONFIG_VALUE_0).toBe("Authorization: Bearer ghs_secret");
    expect(env.GIT_CONFIG_KEY_0).toBe("http.extraHeader");
    expect(env.GIT_TERMINAL_PROMPT).toBe("0");
  });

  test("refuses shell metacharacters in the clone URL and branch", () => {
    expect(() => buildCloneCommand({ url: "https://github.com/acme/demo.git; rm -rf /" })).toThrow(
      /Unsupported clone URL/,
    );
    expect(() =>
      buildCloneCommand({ url: "https://github.com/acme/demo.git", branch: "main;whoami" }),
    ).toThrow(/Invalid branch name/);
  });
});
