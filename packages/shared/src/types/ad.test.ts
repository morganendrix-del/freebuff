import { describe, expect, expectTypeOf, test } from "vitest";

import { isJsonObject, isJsonValue } from "./json";
import { createId } from "./ids";
import type { AdCreative, AdSelection } from "./ad";
import { SPONSORED_LABEL } from "./ad";

const creative: AdCreative = {
  id: createId("ad"),
  sponsor: "Acme DevTools",
  headline: "Ship faster with typed APIs",
  body: "Acme generates clients from your schema.",
  displayUrl: "acme.example",
  targetUrl: "https://acme.example/freebuff",
  categories: ["developer-tools"],
  label: SPONSORED_LABEL,
  eligibleTiers: ["free"],
  weight: 1,
  active: true,
};

describe("AdCreative labelling", () => {
  test("every creative carries the Sponsored label at runtime", () => {
    expect(creative.label).toBe("Sponsored");
    expect(SPONSORED_LABEL).toBe("Sponsored");
  });

  test("the label is a fixed literal at the type level", () => {
    expectTypeOf<AdCreative["label"]>().toEqualTypeOf<"Sponsored">();
    expectTypeOf<AdSelection["label"]>().toEqualTypeOf<"Sponsored">();
    // A wider string type would let a deceptive label through, so it must not be assignable.
    expectTypeOf<AdCreative["label"]>().not.toEqualTypeOf<string>();

    const unlabelled: AdCreative = {
      ...creative,
      // @ts-expect-error - label is fixed to the "Sponsored" literal; arbitrary labels are rejected
      label: "Ad",
    };
    expect(unlabelled.label).toBe("Ad");
  });

  test("paid tiers are excluded by entitlement data, not by renderers", () => {
    expect(creative.eligibleTiers).toEqual(["free"]);
    expect(isJsonValue(creative)).toBe(true);
    expect(isJsonObject(creative)).toBe(true);
  });
});
