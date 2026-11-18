import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

const entry = (packageName: string): string =>
  fileURLToPath(new URL(`./packages/${packageName}/src/index.ts`, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "@freebuff/shared": entry("shared"),
      "@freebuff/llm-providers": entry("llm-providers"),
      "@freebuff/code-map": entry("code-map"),
      "@freebuff/agent-runtime": entry("agent-runtime"),
    },
  },
  test: {
    environment: "node",
    include: [
      "packages/**/src/**/*.test.ts",
      "packages/*/test/**/*.test.ts",
      "apps/**/src/**/*.test.ts",
      "apps/*/test/**/*.test.ts",
      "infra/**/*.test.ts",
      "tests/unit/**/*.test.ts",
      "tests/integration/**/*.test.ts",
    ],
    exclude: ["**/node_modules/**", "**/dist/**", "tests/e2e/**"],
    passWithNoTests: false,
    testTimeout: 15_000,
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov"],
      include: ["packages/*/src/**/*.ts", "apps/*/src/**/*.ts", "infra/**/*.ts"],
      exclude: ["**/*.test.ts", "**/dist/**"],
    },
  },
});
