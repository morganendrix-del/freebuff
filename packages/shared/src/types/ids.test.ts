import { describe, expect, test } from "vitest";

import { createId, isId } from "./ids";

describe("ids", () => {
  test("creates prefixed, unique ids", () => {
    const first = createId("session");
    const second = createId("session");

    expect(first.startsWith("session_")).toBe(true);
    expect(first).not.toBe(second);
  });

  test("validates kind and shape", () => {
    const sessionId = createId("session");
    expect(isId("session", sessionId)).toBe(true);
    expect(isId("project", sessionId)).toBe(false);
    expect(isId("session", "session_short")).toBe(false);
    expect(isId("session", `session_${"z".repeat(32)}`)).toBe(false);
    expect(isId("session", 42)).toBe(false);
  });
});
