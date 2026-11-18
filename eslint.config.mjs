import js from "@eslint/js";
import prettier from "eslint-config-prettier";
import tseslint from "typescript-eslint";

const MODEL_ID_PATTERN = /^(?:deepseek|claude|gpt)-[a-z0-9._-]+$/i;

/**
 * Model choice must flow through resolveModelForTier (spec: no hardcoded model names outside config).
 * Anything that looks like a provider model id outside the catalogue is an error.
 */
const noHardcodedModel = {
  meta: {
    type: "problem",
    docs: { description: "Model ids must be resolved from tier configuration" },
    schema: [],
    messages: {
      hardcoded:
        'Do not hardcode model id "{{value}}"; select models through resolveModelForTier instead.',
    },
  },
  create(context) {
    return {
      Literal(node) {
        if (typeof node.value !== "string") return;
        if (!MODEL_ID_PATTERN.test(node.value)) return;
        context.report({ node, messageId: "hardcoded", data: { value: node.value } });
      },
    };
  },
};

const freebuffPlugin = { rules: { "no-hardcoded-model": noHardcodedModel } };

export default tseslint.config(
  {
    ignores: [
      "**/node_modules/**",
      "**/dist/**",
      "**/build/**",
      "**/coverage/**",
      "**/.next/**",
      "**/.turbo/**",
      "**/bun.lock",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/consistent-type-imports": ["error", { prefer: "type-imports" }],
      "@typescript-eslint/no-non-null-assertion": "error",
      "@typescript-eslint/require-await": "error",
      "@typescript-eslint/no-unnecessary-condition": [
        "error",
        { allowConstantLoopConditions: true },
      ],
      "@typescript-eslint/switch-exhaustiveness-check": [
        "error",
        { considerDefaultExhaustiveForUnions: true },
      ],
      "no-console": "error",
      eqeqeq: ["error", "always"],
      "prefer-const": "error",
      "no-var": "error",
    },
  },
  {
    files: ["packages/*/src/**/*.ts", "apps/*/src/**/*.ts"],
    ignores: ["**/*.test.ts", "packages/shared/src/config/models.ts"],
    plugins: { freebuff: freebuffPlugin },
    rules: {
      "freebuff/no-hardcoded-model": "error",
    },
  },
  {
    files: ["infra/sandbox/**/*.ts"],
    rules: {
      "no-console": "off",
    },
  },
  {
    files: ["**/*.test.ts", "tests/**/*.ts"],
    rules: {
      "@typescript-eslint/no-non-null-assertion": "off",
      // Test doubles are intentionally async without awaiting.
      "@typescript-eslint/require-await": "off",
    },
  },
  {
    files: ["**/*.mjs", "**/*.js"],
    extends: [tseslint.configs.disableTypeChecked],
  },
  prettier,
);
