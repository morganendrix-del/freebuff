import { PlatformError } from "@freebuff/shared";
import type { JsonValue, ProviderId } from "@freebuff/shared";

export type ProviderErrorCode =
  | "empty_stream"
  | "invalid_credentials"
  | "invalid_request"
  | "malformed_stream"
  | "model_not_found"
  | "provider_unavailable"
  | "rate_limited"
  | "transport_error"
  | "truncated_stream";

export interface ProviderErrorOptions {
  readonly status?: number;
  readonly retryable?: boolean;
  readonly cause?: unknown;
  readonly details?: JsonValue;
}

export class ProviderError extends PlatformError {
  readonly providerId: ProviderId;
  readonly status: number | undefined;

  constructor(
    providerId: ProviderId,
    code: ProviderErrorCode,
    message: string,
    options: ProviderErrorOptions = {},
  ) {
    super(code, message, {
      retryable: options.retryable ?? false,
      ...(options.cause === undefined ? {} : { cause: options.cause }),
      ...(options.details === undefined ? {} : { details: options.details }),
    });
    this.name = "ProviderError";
    this.providerId = providerId;
    this.status = options.status;
  }
}

/**
 * Maps an HTTP failure to a typed, retry-classified error. Response bodies are deliberately not
 * copied into the error: they can echo prompts, which must never reach logs or user surfaces.
 */
export function providerErrorFromStatus(providerId: ProviderId, status: number): ProviderError {
  if (status === 401 || status === 403) {
    return new ProviderError(
      providerId,
      "invalid_credentials",
      `${providerId} rejected the API credentials (HTTP ${String(status)}).`,
      { status },
    );
  }
  if (status === 404) {
    return new ProviderError(
      providerId,
      "model_not_found",
      `${providerId} reports the requested model is unavailable (HTTP 404).`,
      { status },
    );
  }
  if (status === 408 || status === 409 || status === 429) {
    return new ProviderError(
      providerId,
      "rate_limited",
      `${providerId} asked us to slow down (HTTP ${String(status)}).`,
      { status, retryable: true },
    );
  }
  if (status >= 500) {
    return new ProviderError(
      providerId,
      "provider_unavailable",
      `${providerId} is unavailable (HTTP ${String(status)}).`,
      { status, retryable: true },
    );
  }
  return new ProviderError(
    providerId,
    "invalid_request",
    `${providerId} rejected the request (HTTP ${String(status)}).`,
    { status },
  );
}
