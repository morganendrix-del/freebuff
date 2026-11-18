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

describe("jitter bounds", () => {
  const policy: RetryPolicy = {
    maxAttempts: 8,
    baseDelayMs: 1_000,
    maxDelayMs: 16_000,
    jitterRatio: 0.25,
  };

  test("every random draw stays inside the band and is an integer", () => {
    for (const attempt of [1, 2, 3, 4, 5, 6, 9]) {
      const exponential = Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** (attempt - 1));
      for (const draw of [0, 0.01, 0.25, 0.5, 0.75, 0.99, 1]) {
        const delay = computeBackoffMs(attempt, policy, () => draw);
        expect(Number.isInteger(delay)).toBe(true);
        expect(delay).toBeGreaterThanOrEqual(Math.floor(exponential * 0.75));
        expect(delay).toBeLessThanOrEqual(Math.ceil(exponential * 1.25));
      }
    }
  });

  test("the ceiling is hard, even with maximum jitter", () => {
    expect(computeBackoffMs(30, policy, () => 1)).toBe(policy.maxDelayMs);
    expect(computeBackoffMs(30, policy, () => 0)).toBe(policy.maxDelayMs * 0.75);
  });

  test("delays are never negative for out-of-range random draws", () => {
    expect(computeBackoffMs(1, { ...policy, jitterRatio: 5 }, () => 1)).toBeGreaterThanOrEqual(0);
    expect(computeBackoffMs(0, policy, () => 0)).toBeGreaterThanOrEqual(0);
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
  test("stays closed below the failure threshold", () => {
    const now = 0;
    const breaker = new CircuitBreaker({
      policy: { failureThreshold: 3, resetTimeoutMs: 1_000 },
      now: () => now,
    });

    breaker.recordFailure();
    breaker.recordFailure();
    expect(breaker.state).toBe("closed");
    expect(breaker.canRequest()).toBe(true);

    breaker.recordSuccess();
    breaker.recordFailure();
    breaker.recordFailure();
    expect(breaker.state).toBe("closed");
  });

  test("a failed half-open probe reopens and restarts the cooldown", () => {
    let now = 0;
    const breaker = new CircuitBreaker({
      policy: { failureThreshold: 2, resetTimeoutMs: 100 },
      now: () => now,
    });

    breaker.recordFailure();
    breaker.recordFailure();
    expect(breaker.state).toBe("open");

    now = 99;
    expect(breaker.state).toBe("open");
    now = 100;
    expect(breaker.state).toBe("half_open");
    expect(breaker.canRequest()).toBe(true);

    breaker.recordFailure();
    expect(breaker.state).toBe("open");

    now = 150;
    expect(breaker.state).toBe("open");
    now = 200;
    expect(breaker.state).toBe("half_open");

    breaker.recordSuccess();
    expect(breaker.state).toBe("closed");
    expect(breaker.canRequest()).toBe(true);
  });

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
