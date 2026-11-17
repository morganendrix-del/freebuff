import { describe, expect, test } from "vitest";

import { PlatformError } from "../utils/errors";
import { loadEnv, requireEnvValue } from "./env";

function attempt(source: Record<string, string | undefined>) {
  try {
    return { ok: true as const, env: loadEnv(source) };
  } catch (error) {
    return { ok: false as const, error };
  }
}

describe("loadEnv", () => {
  test("applies defaults for an empty environment", () => {
    const result = attempt({});
    expect(result.ok).toBe(true);
    if (!result.ok) throw result.error;

    expect(result.env.NODE_ENV).toBe("development");
    expect(result.env.SANDBOX_HTTP_PORT).toBe(8788);
    expect(result.env.SANDBOX_IMAGE).toBe("freebuff/sandbox:local");
    expect(result.env.DATABASE_URL).toBeUndefined();
  });

  test("treats blank optional values as unset", () => {
    const result = attempt({ SESSION_SECRET: "", DATABASE_URL: "", DEEPSEEK_API_KEY: "  " });
    expect(result.ok).toBe(true);
    if (!result.ok) throw result.error;
    expect(result.env.SESSION_SECRET).toBeUndefined();
    expect(result.env.DATABASE_URL).toBeUndefined();
    expect(result.env.DEEPSEEK_API_KEY).toBeUndefined();
  });

  test("parses valid values", () => {
    const result = attempt({
      NODE_ENV: "production",
      DATABASE_URL: "postgres://user:pass@localhost:5432/db",
      SESSION_SECRET: "x".repeat(32),
      SANDBOX_HTTP_PORT: "9000",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw result.error;

    expect(result.env.NODE_ENV).toBe("production");
    expect(result.env.SANDBOX_HTTP_PORT).toBe(9000);
  });

  test("rejects invalid values with a message that names the variable but not the value", () => {
    const secret = "s3cr3t-too-short";
    const result = attempt({ SESSION_SECRET: secret, NODE_ENV: "staging" });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected invalid environment to be rejected");

    expect(result.error).toBeInstanceOf(PlatformError);
    const { message } = result.error as PlatformError;
    expect(message).toContain("SESSION_SECRET");
    expect(message).toContain("NODE_ENV");
    expect(message).not.toContain(secret);
  });

  test("rejects out-of-range ports and malformed URLs", () => {
    expect(attempt({ SANDBOX_HTTP_PORT: "99" }).ok).toBe(false);
    expect(attempt({ SANDBOX_HTTP_PORT: "abc" }).ok).toBe(false);
    expect(attempt({ DATABASE_URL: "not a url" }).ok).toBe(false);
  });
});

describe("requireEnvValue", () => {
  test("returns present values and fails loudly on missing ones", () => {
    const result = attempt({ DATABASE_URL: "postgres://localhost:5432/db" });
    if (!result.ok) throw result.error;

    expect(requireEnvValue(result.env, "DATABASE_URL")).toBe("postgres://localhost:5432/db");
    expect(() => requireEnvValue(result.env, "CONVEX_URL")).toThrow(PlatformError);
  });
});
