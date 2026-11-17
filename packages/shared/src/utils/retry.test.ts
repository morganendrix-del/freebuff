import { describe, expect, test } from "vitest";

import { CancelledError, PlatformError, RetryExhaustedError, TimeoutError } from "./errors";
import {
  CircuitBreaker,
  computeBackoffMs,
  withRetry,
  withTimeout,
  type RetryPolicy,
} from "./retry";

const POLICY: RetryPolicy = { maxAttempts: 3, baseDelayMs: 10, maxDelayMs: 100, jitterRatio: 0 };
const noSleep = async (): Promise<void> => undefined;

describe("computeBackoffMs", () => {
  test("grows exponentially and clamps at the ceiling", () => {
    expect(computeBackoffMs(1, POLICY)).toBe(10);
    expect(computeBackoffMs(2, POLICY)).toBe(20);
    expect(computeBackoffMs(3, POLICY)).toBe(40);
    expect(computeBackoffMs(12, POLICY)).toBe(100);
  });

  test("applies bounded symmetric jitter", () => {
    const jittered: RetryPolicy = { ...POLICY, jitterRatio: 0.5 };
    expect(computeBackoffMs(1, jittered, () => 0)).toBe(5);
    expect(computeBackoffMs(1, jittered, () => 1)).toBe(15);
  });
});

describe("withRetry", () => {
  test("retries transient failures until success", async () => {
    let calls = 0;
    const result = await withRetry(
      async (attempt) => {
        calls += 1;
        if (attempt < 3) {
          throw new PlatformError("upstream", "temporary", { retryable: true });
        }
        return "done";
      },
      { policy: POLICY, sleep: noSleep },
    );

    expect(result).toBe("done");
    expect(calls).toBe(3);
  });

  test("reports exhaustion after the final attempt", async () => {
    let calls = 0;
    const failure = withRetry(
      async () => {
        calls += 1;
        throw new PlatformError("upstream", "still down", { retryable: true });
      },
      { policy: POLICY, sleep: noSleep },
    );

    await expect(failure).rejects.toBeInstanceOf(RetryExhaustedError);
    expect(calls).toBe(3);
  });

  test("does not retry non-retryable errors", async () => {
    let calls = 0;
    const failure = withRetry(
      async () => {
        calls += 1;
        throw new PlatformError("invalid_input", "bad request");
      },
      { policy: POLICY, sleep: noSleep },
    );

    await expect(failure).rejects.toBeInstanceOf(PlatformError);
    expect(calls).toBe(1);
  });

  test("honours an abort signal before starting", async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(
      withRetry(async () => "never", { policy: POLICY, signal: controller.signal }),
    ).rejects.toBeInstanceOf(CancelledError);
  });

  test("passes the attempt number to the retry hook", async () => {
    const attempts: number[] = [];
    await withRetry(
      async (attempt) => {
        if (attempt < 2) throw new PlatformError("upstream", "flaky", { retryable: true });
        return attempt;
      },
      {
        policy: POLICY,
        sleep: noSleep,
        onRetry: ({ attempt, delayMs }) => attempts.push(attempt * 1_000 + delayMs),
      },
    );

    expect(attempts).toEqual([1_010]);
  });
});

describe("withTimeout", () => {
  test("resolves fast operations", async () => {
    await expect(withTimeout(async () => "fast", 1_000)).resolves.toBe("fast");
  });

  test("rejects with TimeoutError when the deadline passes", async () => {
    const hanging = (): Promise<never> => new Promise<never>(() => undefined);

    await expect(withTimeout(hanging, 5)).rejects.toBeInstanceOf(TimeoutError);
  });
});

describe("CircuitBreaker", () => {
  test("opens after repeated failures, then probes and closes", async () => {
    let now = 0;
    const breaker = new CircuitBreaker({
      policy: { failureThreshold: 2, resetTimeoutMs: 100 },
      now: () => now,
    });
    const failing = async (): Promise<never> => {
      throw new Error("dependency down");
    };

    await expect(breaker.execute(failing)).rejects.toThrow("dependency down");
    expect(breaker.state).toBe("closed");

    await expect(breaker.execute(failing)).rejects.toThrow("dependency down");
    expect(breaker.state).toBe("open");
    expect(breaker.canRequest()).toBe(false);
    await expect(breaker.execute(async () => "blocked")).rejects.toMatchObject({
      code: "circuit_open",
    });

    now = 100;
    expect(breaker.state).toBe("half_open");
    await expect(breaker.execute(async () => "recovered")).resolves.toBe("recovered");
    expect(breaker.state).toBe("closed");
  });
});
