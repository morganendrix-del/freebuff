import { describe, expect, test } from "vitest";

import { isSensitiveKey, redact } from "./redact";

describe("isSensitiveKey", () => {
  test("catches credential shapes regardless of casing and separators", () => {
    for (const key of [
      "authorization",
      "SESSION_SECRET",
      "x-api-key",
      "apiKey",
      "refreshToken",
      "user.password",
      "otp",
      "cookie",
    ]) {
      expect(isSensitiveKey(key)).toBe(true);
    }
  });

  test("catches payload shapes but leaves operational fields readable", () => {
    expect(isSensitiveKey("prompt")).toBe(true);
    expect(isSensitiveKey("fileContents")).toBe(true);
    expect(isSensitiveKey("diff")).toBe(true);
    expect(isSensitiveKey("toolName")).toBe(false);
    expect(isSensitiveKey("code")).toBe(false);
    expect(isSensitiveKey("statusCode")).toBe(false);
  });
});

describe("redact", () => {
  test("redacts credentials and payloads at any depth", () => {
    const input = {
      headers: { authorization: "Bearer abc123", "x-api-key": "sk-live" },
      request: { prompt: "drop the production database", nested: [{ token: "t0ken" }] },
      toolName: "run_command",
    };

    expect(redact(input)).toEqual({
      headers: { authorization: "[REDACTED]", "x-api-key": "[REDACTED]" },
      request: { prompt: "[REDACTED]", nested: [{ token: "[REDACTED]" }] },
      toolName: "run_command",
    });
  });

  test("keeps error codes, which are not secrets", () => {
    expect(redact({ code: "quota_exhausted", message: "out of hours" })).toEqual({
      code: "quota_exhausted",
      message: "out of hours",
    });
  });

  test("survives circular structures", () => {
    const node: Record<string, unknown> = { name: "root" };
    node.self = node;
    expect(redact(node)).toEqual({ name: "root", self: "[Circular]" });
  });

  test("bounds depth and string length", () => {
    expect(redact({ a: { b: { c: "deep" } } }, { maxDepth: 2 })).toEqual({
      a: { b: "[MaxDepth]" },
    });
    const long = "x".repeat(50);
    expect(redact({ note: long }, { maxStringLength: 10 })).toEqual({
      note: "xxxxxxxxxx…[truncated 40 chars]",
    });
  });

  test("normalises non-JSON values", () => {
    expect(redact(new Error("boom"))).toEqual({ name: "Error", message: "boom" });
    expect(redact({ at: new Date("2026-11-17T00:00:00.000Z") })).toEqual({
      at: "2026-11-17T00:00:00.000Z",
    });
    expect(redact({ missing: undefined, fn: () => undefined, big: 10n })).toEqual({
      missing: "[undefined]",
      fn: "[Function]",
      big: "10",
    });
  });
});
