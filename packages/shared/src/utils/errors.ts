import type { JsonValue } from "../types/json";

export interface PlatformErrorOptions {
  readonly retryable?: boolean;
  readonly cause?: unknown;
  readonly details?: JsonValue;
}

/** Base error for everything the platform raises deliberately. */
export class PlatformError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  readonly details: JsonValue | undefined;

  constructor(code: string, message: string, options: PlatformErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "PlatformError";
    this.code = code;
    this.retryable = options.retryable ?? false;
    this.details = options.details;
  }
}

export class ConfigurationError extends PlatformError {
  constructor(message: string, options: PlatformErrorOptions = {}) {
    super("invalid_config", message, options);
    this.name = "ConfigurationError";
  }
}

export class TimeoutError extends PlatformError {
  readonly timeoutMs: number;

  constructor(message: string, timeoutMs: number, options: PlatformErrorOptions = {}) {
    super("timeout", message, { retryable: true, ...options });
    this.name = "TimeoutError";
    this.timeoutMs = timeoutMs;
  }
}

export class CancelledError extends PlatformError {
  constructor(message = "Operation cancelled.") {
    super("cancelled", message);
    this.name = "CancelledError";
  }
}

export class CircuitOpenError extends PlatformError {
  constructor(message = "Circuit breaker is open.") {
    super("circuit_open", message, { retryable: true });
    this.name = "CircuitOpenError";
  }
}

export class RetryExhaustedError extends PlatformError {
  readonly attempts: number;
  readonly lastError: unknown;

  constructor(attempts: number, lastError: unknown) {
    const reason = lastError instanceof Error ? lastError.message : String(lastError);
    super("retry_exhausted", `Retried ${String(attempts)} time(s): ${reason}`, {
      retryable: false,
      cause: lastError,
    });
    this.name = "RetryExhaustedError";
    this.attempts = attempts;
    this.lastError = lastError;
  }
}

export function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

export function toErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  return "Unknown error";
}

/** Throws `CancelledError` when the signal is already aborted. */
export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted === true) throw new CancelledError();
}
