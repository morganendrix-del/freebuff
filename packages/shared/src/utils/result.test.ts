import { describe, expect, test } from "vitest";

import {
  err,
  fromPromise,
  isErr,
  isOk,
  mapError,
  mapResult,
  ok,
  unwrapOr,
  unwrapOrThrow,
} from "./result";

describe("Result", () => {
  test("narrows on the ok discriminant", () => {
    const success = ok(1);
    const failure = err("nope");
    expect(isOk(success)).toBe(true);
    expect(isErr(failure)).toBe(true);
    expect(isErr(success)).toBe(false);
  });

  test("maps values only on success", () => {
    expect(mapResult(ok(2), (value) => value * 3)).toEqual(ok(6));
    expect(mapResult(err("bad"), (value: number) => value * 3)).toEqual(err("bad"));
  });

  test("maps errors only on failure", () => {
    expect(mapError(err("bad"), (error) => error.length)).toEqual(err(3));
    expect(mapError(ok("value"), (error: string) => error.length)).toEqual(ok("value"));
  });

  test("unwraps with fallbacks and throws on demand", () => {
    expect(unwrapOr(ok(1), 7)).toBe(1);
    expect(unwrapOr(err("bad"), 7)).toBe(7);
    expect(() => unwrapOrThrow(err("bad"))).toThrow("Result was an error.");
    expect(() => unwrapOrThrow(err({ code: "x" }), (error) => error.code)).toThrow("x");
    expect(unwrapOrThrow(ok(5), () => "unused")).toBe(5);
  });

  test("fromPromise captures rejections", async () => {
    await expect(fromPromise(Promise.resolve(1))).resolves.toEqual(ok(1));
    const rejected = await fromPromise(Promise.reject(new Error("boom")));
    expect(rejected.ok).toBe(false);
  });
});
