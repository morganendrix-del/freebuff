import { PlatformError } from "@freebuff/shared";
import type { ApiErrorCode, JsonValue } from "@freebuff/shared";

export interface SdkErrorOptions {
  readonly code: ApiErrorCode;
  readonly status: number;
  readonly requestId: string;
  readonly retryable?: boolean;
  readonly details?: JsonValue;
  readonly cause?: unknown;
}

/** Any non-2xx platform response, or a transport failure that never produced one. */
export class SdkError extends PlatformError {
  readonly status: number;
  readonly requestId: string;
  readonly apiCode: ApiErrorCode;

  constructor(message: string, options: SdkErrorOptions) {
    super(options.code, message, {
      retryable: options.retryable ?? false,
      ...(options.details === undefined ? {} : { details: options.details }),
      ...(options.cause === undefined ? {} : { cause: options.cause }),
    });
    this.name = "SdkError";
    this.status = options.status;
    this.requestId = options.requestId;
    this.apiCode = options.code;
  }
}

const STATUS_TO_CODE: Readonly<Record<number, ApiErrorCode>> = {
  400: "invalid_request",
  401: "unauthorized",
  402: "payment_required",
  403: "forbidden",
  404: "not_found",
  409: "conflict",
  429: "rate_limited",
  451: "verification_required",
};

export function codeForStatus(status: number): ApiErrorCode {
  const mapped = STATUS_TO_CODE[status];
  if (mapped !== undefined) return mapped;
  return status === 429 ? "rate_limited" : "internal";
}

export function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}
