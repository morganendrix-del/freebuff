import { describe, expect, test } from "vitest";

import { detectPreviewPort, normalizePreviewUrl, stripAnsi } from "./detect-preview";
import { buildCommandScript } from "./exec";

describe("preview detection", () => {
  test("reads the port from a local URL, ignoring ANSI colours", () => {
    const log = "\u001B[32m➜\u001B[0m  Local:   http://localhost:5173/\n";
    expect(detectPreviewPort(log)).toBe(5173);
    expect(stripAnsi(log)).toContain("Local:");
  });

  test("understands bare host:port lines and 'listening on port' messages", () => {
    expect(detectPreviewPort("server running at 127.0.0.1:3000")).toBe(3000);
    expect(detectPreviewPort("Listening on port 8080")).toBe(8080);
  });

  test("prefers the most recent announcement", () => {
    expect(detectPreviewPort("http://localhost:3000\nhttp://localhost:4173\nready")).toBe(4173);
  });

  test("returns undefined when nothing was announced", () => {
    expect(detectPreviewPort("building...\ndone in 300ms")).toBeUndefined();
    expect(detectPreviewPort("http://localhost:99999")).toBeUndefined();
  });

  test("normalises wildcard hosts to loopback", () => {
    expect(normalizePreviewUrl("http://0.0.0.0:3000/app#x")).toBe("http://127.0.0.1:3000/app");
  });
});

describe("command limits", () => {
  test("prefixes ulimits for every configured limit", () => {
    const script = buildCommandScript("node app.js", {
      memoryMb: 512,
      cpuSeconds: 30,
      pids: 64,
      fileSizeMb: 2,
    });

    expect(script).toContain("ulimit -v 524288");
    expect(script).toContain("ulimit -t 30");
    expect(script).toContain("ulimit -u 64");
    expect(script).toContain("ulimit -f 2048");
    expect(script.endsWith("node app.js")).toBe(true);
  });

  test("leaves the command untouched without limits", () => {
    expect(buildCommandScript("echo hi")).toBe("echo hi");
  });
});
