import { describe, expect, test } from "vitest";

import {
  DEFAULT_MODEL_CATALOG,
  DEFAULT_TIER_MODEL_POLICY,
  MODEL_CATALOG_METADATA,
  findModel,
  isModelAllowedForTier,
  modelsForTier,
  resolveModelForTier,
} from "./models";
import { DEFAULT_PROVIDER_ENDPOINTS, resolveProviderBaseUrl } from "./providers";

describe("resolveModelForTier", () => {
  test("free tier defaults to the free DeepSeek model", () => {
    const resolved = resolveModelForTier("free");
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) throw new Error(resolved.error.message);

    expect(resolved.value.provider).toBe("deepseek");
    expect(resolved.value.minimumTier).toBe("free");
    expect(resolved.value.id).toBe("deepseek-flash");
  });

  test("free tier cannot select premium models", () => {
    for (const premium of ["claude-sonnet-5-5", "gpt-6-astra", "deepseek-v4-pro"]) {
      const resolved = resolveModelForTier("free", premium);
      expect(resolved.ok).toBe(false);
      if (resolved.ok) throw new Error(`expected ${premium} to be rejected for free tier`);
      expect(resolved.error.code).toBe("tier_not_permitted");
      expect(resolved.error.requiredTier).toBe("pro");
    }
  });

  test("pro tier can select premium and free models", () => {
    for (const modelId of ["gpt-6.1-sol", "claude-opus-5-5", "deepseek-flash"]) {
      const resolved = resolveModelForTier("pro", modelId);
      expect(resolved.ok).toBe(true);
    }
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
      expect(model.pricing.outputPerMTokUsd).toBeGreaterThan(model.pricing.inputPerMTokUsd);

      if (model.pricing.cachedInputPerMTokUsd !== undefined) {
        expect(model.pricing.cachedInputPerMTokUsd).toBeLessThan(model.pricing.inputPerMTokUsd);
      }
      if (model.pricing.offPeakInputPerMTokUsd !== undefined) {
        expect(model.pricing.offPeakInputPerMTokUsd).toBeLessThan(model.pricing.inputPerMTokUsd);
        expect(model.pricing.offPeakOutputPerMTokUsd).toBeDefined();
      }
    }
  });

  test("model ids are unique and carry capabilities the runtime needs", () => {
    const ids = DEFAULT_MODEL_CATALOG.map((model) => model.id);
    expect(new Set(ids).size).toBe(ids.length);

    for (const model of DEFAULT_MODEL_CATALOG) {
      expect(model.capabilities).toContain("streaming");
      expect(model.capabilities).toContain("tools");
      expect(DEFAULT_PROVIDER_ENDPOINTS[model.provider].baseUrl).toMatch(/^https:\/\//);
    }
  });

  test("the catalogue records a retrieval date and sources", () => {
    expect(MODEL_CATALOG_METADATA.retrievedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(MODEL_CATALOG_METADATA.sources.length).toBeGreaterThanOrEqual(3);
  });

  test("modelsForTier never leaks premium models to free", () => {
    const freeModels = modelsForTier("free");
    expect(freeModels.length).toBeGreaterThan(0);
    expect(freeModels.every((model) => model.minimumTier === "free")).toBe(true);
    expect(modelsForTier("pro")).toHaveLength(DEFAULT_MODEL_CATALOG.length);
  });
});

describe("provider endpoints", () => {
  test("defaults to the documented base URLs", () => {
    expect(resolveProviderBaseUrl("deepseek")).toBe("https://api.deepseek.com");
    expect(resolveProviderBaseUrl("openai")).toBe("https://api.openai.com/v1");
    expect(resolveProviderBaseUrl("anthropic")).toBe("https://api.anthropic.com/v1");
  });

  test("accepts a deployment override", () => {
    expect(
      resolveProviderBaseUrl("openai", { OPENAI_BASE_URL: "https://gateway.internal/v1" }),
    ).toBe("https://gateway.internal/v1");
  });
});
