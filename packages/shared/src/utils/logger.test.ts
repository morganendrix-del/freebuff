import { describe, expect, test } from "vitest";

import { createLogger, createNullLogger } from "./logger";

function capture(level: "debug" | "error" | "info" | "warn" = "debug"): {
  lines: string[];
  logger: ReturnType<typeof createLogger>;
} {
  const lines: string[] = [];
  const logger = createLogger({
    level,
    sink: (line) => lines.push(line),
    now: () => new Date("2026-11-17T00:00:00.000Z"),
  });
  return { lines, logger };
}

describe("createLogger", () => {
  test("emits one JSON object per record", () => {
    const { lines, logger } = capture();
    logger.info("tool finished", { tool: "read_file", durationMs: 12 });

    expect(lines).toHaveLength(1);
    const entry = JSON.parse(lines[0] ?? "{}") as Record<string, unknown>;
    expect(entry).toMatchObject({
      level: "info",
      time: "2026-11-17T00:00:00.000Z",
      msg: "tool finished",
      tool: "read_file",
      durationMs: 12,
    });
  });

  test("never emits prompts, code or credentials", () => {
    const { lines, logger } = capture();
    logger.info("agent step", {
      prompt: "delete the production database",
      apiKey: "sk-live-123",
      nested: { authorization: "Bearer session-token" },
      fileContents: "const secret = 1;",
    });

    const raw = lines.join("\n");
    expect(raw).not.toContain("delete the production database");
    expect(raw).not.toContain("sk-live-123");
    expect(raw).not.toContain("Bearer session-token");
    expect(raw).not.toContain("const secret");
    expect(raw).toContain("[REDACTED]");
  });

  test("filters below the configured level", () => {
    const { lines, logger } = capture("warn");
    logger.debug("hidden");
    logger.info("hidden");
    logger.warn("shown");
    expect(lines).toHaveLength(1);
  });

  test("error() carries a redacted cause", () => {
    const { lines, logger } = capture();
    logger.error("provider failed", new Error("401 for key sk-abc"), { provider: "openai" });

    const entry = JSON.parse(lines[0] ?? "{}") as Record<string, unknown>;
    expect(entry.provider).toBe("openai");
    expect(entry.err).toEqual({ name: "Error", message: "401 for key sk-abc" });
  });

  test("child loggers inherit bindings", () => {
    const { lines, logger } = capture();
    logger.child({ component: "quota" }).info("window opened", { dayKey: "2026-11-17" });

    const entry = JSON.parse(lines[0] ?? "{}") as Record<string, unknown>;
    expect(entry.component).toBe("quota");
    expect(entry.dayKey).toBe("2026-11-17");
  });

  test("never throws when the sink does", () => {
    const logger = createLogger({
      sink: () => {
        throw new Error("EPIPE");
      },
    });
    expect(() => {
      logger.info("still fine");
    }).not.toThrow();
    expect(() => {
      createNullLogger().info("silent");
    }).not.toThrow();
  });
});
