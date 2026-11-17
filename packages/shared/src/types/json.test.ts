import { describe, expect, test } from "vitest";

import { isJsonObject, isJsonValue } from "./json";

describe("isJsonValue", () => {
  test("accepts JSON primitives, arrays and plain objects", () => {
    expect(isJsonValue(null)).toBe(true);
    expect(isJsonValue("text")).toBe(true);
    expect(isJsonValue(0)).toBe(true);
    expect(isJsonValue(false)).toBe(true);
    expect(isJsonValue([1, "two", { three: [3] }])).toBe(true);
    expect(isJsonValue({ nested: { deep: true } })).toBe(true);
  });

  test("rejects values that cannot be serialised", () => {
    expect(isJsonValue(undefined)).toBe(false);
    expect(isJsonValue(Number.NaN)).toBe(false);
    expect(isJsonValue(Number.POSITIVE_INFINITY)).toBe(false);
    expect(isJsonValue(() => undefined)).toBe(false);
    expect(isJsonValue(Symbol("x"))).toBe(false);
    expect(isJsonValue(new Date())).toBe(false);
    expect(isJsonValue(new Map())).toBe(false);
    expect(isJsonValue([1, undefined])).toBe(false);
  });
});

describe("isJsonObject", () => {
  test("distinguishes objects from arrays and primitives", () => {
    expect(isJsonObject({ a: 1 })).toBe(true);
    expect(isJsonObject([1])).toBe(false);
    expect(isJsonObject("text")).toBe(false);
    expect(isJsonObject(null)).toBe(false);
  });
});
