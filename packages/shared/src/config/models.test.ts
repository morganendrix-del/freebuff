import { describe, expect, test } from "vitest";

import {
  DEFAULT_MODEL_CATALOG,
  DEFAULT_TIER_MODEL_POLICY,
  findModel,
  isModelAllowedForTier,
  modelsForTier,
  resolveModelForTier,
} from "./models";

describe("resolveModelForTier", () => {
  test("free tier defaults to a free DeepSeek model", () => {
    const resolved = resolveModelForTier("free");
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) throw new Error(resolved.error.message);

    expect(resolved.value.provider).toBe("deepseek");
    expect(resolved.value.minimumTier).toBe("free");
  });

  test("free tier cannot select premium models", () => {
    const resolved = resolveModelForTier("free", "claude-sonnet-4-5");
    expect(resolved.ok).toBe(false);
    if (resolved.ok) throw new Error("expected the premium model to be rejected");

    expect(resolved.error.code).toBe("tier_not_permitted");
    expect(resolved.error.requiredTier).toBe("pro");
  });

  test("pro tier can select both premium and free models", () => {
    const premium = resolveModelForTier("pro", "gpt-5.1");
    const free = resolveModelForTier("pro", "deepseek-chat");
    expect(premium.ok && free.ok).toBe(true);
  });

  test("unknown model ids are rejected", () => {
    const resolved = resolveModelForTier("pro", "gpt-9000");
    expect(resolved.ok).toBe(false);
    if (resolved.ok) throw new Error("expected the unknown model to be rejected");
    expect(resolved.error.code).toBe("unknown_model");
  });
});

describe("catalogue integrity", () => {
  test("every tier policy points at real, allowed models", () => {
    for (const policy of Object.values(DEFAULT_TIER_MODEL_POLICY)) {
      expect(findModel(policy.defaultModelId)).toBeDefined();
      expect(isModelAllowedForTier(policy.defaultModelId, policy.tier)).toBe(true);

      for (const modelId of policy.fallbackOrder) {
        expect(findModel(modelId)).toBeDefined();
        expect(isModelAllowedForTier(modelId, policy.tier)).toBe(true);
      }
    }
  });

  test("model specs are internally consistent", () => {
    for (const model of DEFAULT_MODEL_CATALOG) {
      expect(model.contextWindow).toBeGreaterThan(model.maxOutputTokens);
      expect(model.pricing.inputPerMTokUsd).toBeGreaterThan(0);
      expect(model.pricing.outputPerMTokUsd).toBeGreaterThan(0);
    }
  });

  test("modelsForTier never leaks premium models to free", () => {
    const freeModels = modelsForTier("free");
    expect(freeModels.length).toBeGreaterThan(0);
    expect(freeModels.every((model) => model.minimumTier === "free")).toBe(true);
    expect(modelsForTier("pro")).toHaveLength(DEFAULT_MODEL_CATALOG.length);
  });
});
