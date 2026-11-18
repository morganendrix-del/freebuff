import { DEFAULT_RETRY_POLICY, PlatformError, withRetry, withTimeout } from "@freebuff/shared";
import type { ApiError, ApiResponse, RetryPolicy } from "@freebuff/shared";

import { SdkError, codeForStatus, isRetryableStatus } from "./errors";

export type HttpMethod = "DELETE" | "GET" | "POST";

/** Minimal fetch shape, so tests and alternate runtimes can inject a plain function. */
export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export interface HttpTransportOptions {
  readonly baseUrl: string;
  readonly token?: string;
  readonly fetchImpl?: FetchLike;
  readonly timeoutMs?: number;
  readonly retryPolicy?: RetryPolicy;
  readonly defaultHeaders?: Readonly<Record<string, string>>;
}

export interface SendOptions {
  readonly method: HttpMethod;
  readonly path: string;
  readonly body?: unknown;
  /** Retries are opt-in for mutations; GETs retry by default. */
  readonly retryable?: boolean;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 20_000;

function isApiError(value: unknown): value is ApiError {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as { code?: unknown; message?: unknown };
  return typeof candidate.code === "string" && typeof candidate.message === "string";
}

function isEnvelope<T>(value: unknown): value is ApiResponse<T> {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as { ok?: unknown; data?: unknown; error?: unknown };
  if (candidate.ok === true) return "data" in candidate;
  if (candidate.ok === false) return isApiError(candidate.error);
  return false;
}

/** JSON transport for the platform API: timeout, retry, request ids and envelope handling. */
export class HttpTransport {
  private readonly options: HttpTransportOptions;

  constructor(options: HttpTransportOptions) {
    if (options.baseUrl.trim() === "") {
      throw new PlatformError("invalid_config", "A platform base URL is required.");
    }
    this.options = options;
  }

  async send<T>(options: SendOptions): Promise<T> {
    const retryable = options.retryable ?? options.method === "GET";
    if (!retryable) return this.attempt<T>(options);
    return withRetry(() => this.attempt<T>(options), {
      policy: this.options.retryPolicy ?? DEFAULT_RETRY_POLICY,
      isRetryable: (error: unknown) => error instanceof SdkError && error.retryable,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
  }

  private async attempt<T>(options: SendOptions): Promise<T> {
    const requestId = crypto.randomUUID();
    const url = new URL(options.path, this.options.baseUrl).toString();
    const fetchImpl: FetchLike =
      this.options.fetchImpl ?? ((input, init) => globalThis.fetch(input, init));
    const timeoutMs = options.timeoutMs ?? this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const headers: Record<string, string> = {
      accept: "application/json",
      "x-request-id": requestId,
      ...this.options.defaultHeaders,
    };
    if (this.options.token !== undefined) headers.authorization = `Bearer ${this.options.token}`;
    if (options.body !== undefined) headers["content-type"] = "application/json";

    let response: Response;
    try {
      response = await withTimeout(
        async (timeoutSignal) =>
          fetchImpl(url, {
            method: options.method,
            headers,
            ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
            signal:
              options.signal === undefined
                ? timeoutSignal
                : AbortSignal.any([options.signal, timeoutSignal]),
          }),
        timeoutMs,
        `Platform request timed out after ${String(timeoutMs)} ms.`,
        options.signal,
      );
    } catch (error) {
      if (error instanceof PlatformError) throw error;
      throw new SdkError(`Cannot reach the platform at ${this.options.baseUrl}.`, {
        code: "internal",
        status: 0,
        requestId,
        retryable: true,
        cause: error,
      });
    }

    const text = await response.text();
    const payload = parseJson(text, requestId, response.status);

    if (isEnvelope<T>(payload)) {
      if (payload.ok) return payload.data;
      throw new SdkError(payload.error.message, {
        code: payload.error.code,
        status: response.status,
        requestId: payload.error.requestId || requestId,
        retryable: isRetryableStatus(response.status),
        ...(payload.error.details === undefined ? {} : { details: payload.error.details }),
      });
    }

    if (!response.ok) {
      throw new SdkError(`Platform request failed with status ${String(response.status)}.`, {
        code: codeForStatus(response.status),
        status: response.status,
        requestId,
        retryable: isRetryableStatus(response.status),
      });
    }

    throw new SdkError("Platform returned an unexpected response body.", {
      code: "internal",
      status: response.status,
      requestId,
      retryable: false,
    });
  }
}

function parseJson(text: string, requestId: string, status: number): unknown {
  if (text.trim() === "") return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    throw new SdkError("Platform returned malformed JSON.", {
      code: "internal",
      status,
      requestId,
      retryable: isRetryableStatus(status),
      cause: error,
    });
  }
}
