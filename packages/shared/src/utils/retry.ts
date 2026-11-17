import {
  CancelledError,
  PlatformError,
  RetryExhaustedError,
  TimeoutError,
  isAbortError,
  throwIfAborted,
} from "./errors";

/** Retry policy for every external call (provider, GitHub, sandbox, database). */
export interface RetryPolicy {
  readonly maxAttempts: number;
  readonly baseDelayMs: number;
  readonly maxDelayMs: number;
  /** Fractional jitter, e.g. 0.2 means ±20% of the exponential delay. */
  readonly jitterRatio: number;
}

export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxAttempts: 3,
  baseDelayMs: 250,
  maxDelayMs: 5_000,
  jitterRatio: 0.2,
};

/** Exponential backoff with symmetric jitter, clamped to the policy ceiling. */
export function computeBackoffMs(
  attempt: number,
  policy: RetryPolicy = DEFAULT_RETRY_POLICY,
  random: () => number = Math.random,
): number {
  const safeAttempt = Math.max(1, attempt);
  const exponential = Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** (safeAttempt - 1));
  const jitter = exponential * policy.jitterRatio * (random() * 2 - 1);
  return Math.max(0, Math.round(exponential + jitter));
}

export type Sleep = (ms: number, signal?: AbortSignal) => Promise<void>;

const defaultSleep: Sleep = async (ms, signal) => {
  if (ms <= 0) {
    throwIfAborted(signal);
    return;
  }

  await new Promise<void>((resolve, reject) => {
    const cleanup = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    };
    const onAbort = (): void => {
      cleanup();
      reject(new CancelledError("Retry delay cancelled."));
    };
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);

    if (signal) {
      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener("abort", onAbort, { once: true });
    }
  });
};

export interface RetryOptions {
  readonly policy?: RetryPolicy;
  readonly signal?: AbortSignal;
  readonly isRetryable?: (error: unknown) => boolean;
  readonly onRetry?: (info: {
    readonly attempt: number;
    readonly delayMs: number;
    readonly error: unknown;
  }) => void;
  readonly sleep?: Sleep;
  readonly random?: () => number;
}

function defaultIsRetryable(error: unknown): boolean {
  if (error instanceof PlatformError) return error.retryable;
  return !isAbortError(error);
}

/** Runs an operation with bounded retries. Aborts are never retried. */
export async function withRetry<T>(
  operation: (attempt: number) => Promise<T>,
  options: RetryOptions = {},
): Promise<T> {
  const policy = options.policy ?? DEFAULT_RETRY_POLICY;
  if (!Number.isInteger(policy.maxAttempts) || policy.maxAttempts < 1) {
    throw new PlatformError("invalid_config", "Retry maxAttempts must be an integer >= 1.");
  }

  const sleep = options.sleep ?? defaultSleep;
  const isRetryable = options.isRetryable ?? defaultIsRetryable;

  let lastError: unknown;
  let attempt = 0;

  while (attempt < policy.maxAttempts) {
    attempt += 1;
    throwIfAborted(options.signal);

    try {
      return await operation(attempt);
    } catch (error) {
      lastError = error;
      if (isAbortError(error) || error instanceof CancelledError) throw error;

      const hasAttemptsLeft = attempt < policy.maxAttempts;
      if (!hasAttemptsLeft || !isRetryable(error)) {
        if (attempt === 1) throw error;
        throw new RetryExhaustedError(attempt, lastError);
      }

      const delayMs = computeBackoffMs(attempt, policy, options.random);
      options.onRetry?.({ attempt, delayMs, error });
      await sleep(delayMs, options.signal);
    }
  }

  throw new RetryExhaustedError(attempt, lastError);
}

/** Races an operation against a timeout, aborting it through the provided signal. */
export async function withTimeout<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
  message = "Operation timed out.",
): Promise<T> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new PlatformError("invalid_config", "Timeout must be a positive number of milliseconds.");
  }

  const controller = new AbortController();
  const timeoutError = new TimeoutError(message, timeoutMs);
  let timer: ReturnType<typeof setTimeout> | undefined;

  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(timeoutError);
    }, timeoutMs);
  });

  try {
    return await Promise.race([operation(controller.signal), timeoutPromise]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export type CircuitState = "closed" | "half_open" | "open";

export interface CircuitBreakerPolicy {
  readonly failureThreshold: number;
  readonly resetTimeoutMs: number;
}

export const DEFAULT_CIRCUIT_POLICY: CircuitBreakerPolicy = {
  failureThreshold: 5,
  resetTimeoutMs: 30_000,
};

export interface CircuitBreakerOptions {
  readonly policy?: CircuitBreakerPolicy;
  readonly now?: () => number;
}

/** Prevents hammering a failing dependency; one probe is allowed after the reset timeout. */
export class CircuitBreaker {
  readonly #policy: CircuitBreakerPolicy;
  readonly #now: () => number;

  #state: CircuitState = "closed";
  #failures = 0;
  #openedAt = 0;

  constructor(options: CircuitBreakerOptions = {}) {
    this.#policy = options.policy ?? DEFAULT_CIRCUIT_POLICY;
    this.#now = options.now ?? (() => Date.now());
  }

  get state(): CircuitState {
    this.#refresh();
    return this.#state;
  }

  canRequest(): boolean {
    this.#refresh();
    return this.#state !== "open";
  }

  recordSuccess(): void {
    this.#failures = 0;
    this.#state = "closed";
  }

  recordFailure(): void {
    this.#failures += 1;
    if (this.#state === "half_open" || this.#failures >= this.#policy.failureThreshold) {
      this.#state = "open";
      this.#openedAt = this.#now();
    }
  }

  async execute<T>(operation: () => Promise<T>): Promise<T> {
    if (!this.canRequest()) {
      throw new PlatformError("circuit_open", "Circuit breaker is open.");
    }

    try {
      const result = await operation();
      this.recordSuccess();
      return result;
    } catch (error) {
      this.recordFailure();
      throw error;
    }
  }

  #refresh(): void {
    if (this.#state === "open" && this.#now() - this.#openedAt >= this.#policy.resetTimeoutMs) {
      this.#state = "half_open";
    }
  }
}
