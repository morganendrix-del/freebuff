import { TimeoutError } from "@freebuff/shared";
import { describe, expect, test } from "vitest";

import { SdkError, createPlatformClient } from "@freebuff/sdk";
import type { FetchLike } from "@freebuff/sdk";

const FAST_RETRY = { maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 2, jitterRatio: 0 };

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function clientWith(fetchImpl: FetchLike, token = "fb_test") {
  return createPlatformClient({
    baseUrl: "http://platform.test",
    token,
    fetchImpl,
    retryPolicy: FAST_RETRY,
    timeoutMs: 50,
  });
}

describe("platform SDK transport", () => {
  test("sends the bearer token and request id, and unwraps the envelope", async () => {
    const seen: RequestInit[] = [];
    const client = clientWith(async (_input, init) => {
      seen.push(init);
      return jsonResponse({ ok: true, data: { id: "user_1", email: "dev@example.com" } });
    });

    const user = await client.auth.me();
    expect(user).toMatchObject({ id: "user_1" });

    const headers = seen[0]?.headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer fb_test");
    expect(headers["x-request-id"]).toBeTypeOf("string");
  });

  test("does not retry an unauthorized response", async () => {
    let calls = 0;
    const client = clientWith(async () => {
      calls += 1;
      return jsonResponse(
        { ok: false, error: { code: "unauthorized", message: "no token", requestId: "req_1" } },
        401,
      );
    });

    const failure = await client.auth.me().catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(SdkError);
    expect(failure).toMatchObject({ apiCode: "unauthorized", status: 401, retryable: false });
    expect(calls).toBe(1);
  });

  test("retries GETs on 429 and succeeds", async () => {
    let calls = 0;
    const client = clientWith(async () => {
      calls += 1;
      if (calls === 1)
        return jsonResponse(
          { ok: false, error: { code: "rate_limited", message: "slow down", requestId: "r" } },
          429,
        );
      return jsonResponse({ ok: true, data: { items: [] } });
    });

    expect(await client.projects.list()).toEqual([]);
    expect(calls).toBe(2);
  });

  test("never retries a mutating request", async () => {
    let calls = 0;
    const client = clientWith(async () => {
      calls += 1;
      return jsonResponse(
        { ok: false, error: { code: "internal", message: "boom", requestId: "r" } },
        500,
      );
    });

    await expect(client.quota.authorizeRun()).rejects.toMatchObject({
      apiCode: "internal",
      status: 500,
    });
    expect(calls).toBe(1);
  });

  test("maps malformed JSON to an internal error rather than crashing", async () => {
    const client = clientWith(
      async () => new Response("<html>bad gateway</html>", { status: 200 }),
    );

    await expect(client.auth.me()).rejects.toMatchObject({ apiCode: "internal" });
  });

  test("times out a hung platform call", async () => {
    const client = clientWith(
      (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => {
            reject(new DOMException("aborted", "AbortError"));
          });
        }),
    );

    await expect(client.sessions.list()).rejects.toBeInstanceOf(TimeoutError);
  });
});
