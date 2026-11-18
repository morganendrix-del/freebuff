import {
  CancelledError,
  CircuitBreaker,
  DEFAULT_RETRY_POLICY,
  PlatformError,
  TimeoutError,
  isAbortError,
  withRetry,
} from "@freebuff/shared";
import type { ProviderId, RetryPolicy } from "@freebuff/shared";

import { ProviderError, providerErrorFromStatus } from "./errors";
import type { Transport, TransportRequest } from "./types";

export const DEFAULT_PROVIDER_TIMEOUT_MS = 120_000;

export const fetchTransport: Transport = async (request: TransportRequest) =>
  fetch(request.url, {
    method: "POST",
    headers: request.headers,
    body: request.body,
    signal: request.signal,
  });

export interface ProviderHttpConfig {
  readonly providerId: ProviderId;
  readonly baseUrl: string;
  /** Auth and protocol headers contributed by the adapter. */
  readonly headers: Readonly<Record<string, string>>;
  readonly transport: Transport | undefined;
  readonly timeoutMs: number | undefined;
  readonly retryPolicy: RetryPolicy | undefined;
  readonly breaker: CircuitBreaker | undefined;
}

export interface OpenStreamRequest {
  readonly path: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body: string;
  readonly signal: AbortSignal;
}

export interface OpenStreamResult {
  readonly response: Response;
  /** Detaches the caller's abort listener once the body has been consumed. */
  readonly release: () => void;
}

function joinUrl(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, "")}${path.startsWith("/") ? path : `/${path}`}`;
}

/**
 * Opens a streaming request. Timeouts, retries and the circuit breaker apply to establishing the
 * stream (status/headers). Once bytes flow a retry would duplicate output, so mid-stream failures
 * surface as errors and the run fails instead.
 */
export async function openProviderStream(
  config: ProviderHttpConfig,
  request: OpenStreamRequest,
): Promise<OpenStreamResult> {
  const transport = config.transport ?? fetchTransport;
  const breaker = config.breaker ?? new CircuitBreaker();
  const timeoutMs = config.timeoutMs ?? DEFAULT_PROVIDER_TIMEOUT_MS;
  const retryPolicy = config.retryPolicy ?? DEFAULT_RETRY_POLICY;
  const url = joinUrl(config.baseUrl, request.path);

  // Read through a function so TypeScript does not narrow `aborted` to `false` for the whole
  // attempt (the signal can be aborted while the request is in flight).
  const callerAborted = (): boolean => request.signal.aborted;

  const attempt = async (): Promise<OpenStreamResult> => {
    if (callerAborted()) throw new CancelledError("Provider request cancelled.");

    const controller = new AbortController();
    const onAbort = (): void => {
      controller.abort();
    };
    request.signal.addEventListener("abort", onAbort, { once: true });

    let headerTimer: ReturnType<typeof setTimeout> | undefined = setTimeout(() => {
      controller.abort();
    }, timeoutMs);

    const clearHeaderTimer = (): void => {
      if (headerTimer !== undefined) {
        clearTimeout(headerTimer);
        headerTimer = undefined;
      }
    };

    const release = (): void => {
      clearHeaderTimer();
      request.signal.removeEventListener("abort", onAbort);
    };

    try {
      const response = await transport({
        url,
        headers: {
          accept: "text/event-stream",
          "content-type": "application/json",
          ...config.headers,
          ...request.headers,
        },
        body: request.body,
        signal: controller.signal,
      });

      if (response.status < 200 || response.status >= 300) {
        release();
        throw providerErrorFromStatus(config.providerId, response.status);
      }
      if (!response.body) {
        release();
        throw new ProviderError(
          config.providerId,
          "empty_stream",
          `${config.providerId} returned an empty stream.`,
          { retryable: true },
        );
      }

      clearHeaderTimer();
      return { response, release };
    } catch (error) {
      release();
      if (callerAborted()) throw new CancelledError("Provider request cancelled.");
      if (error instanceof ProviderError) throw error;
      if (isAbortError(error)) {
        throw new TimeoutError(
          `${config.providerId} did not respond within ${String(timeoutMs)}ms.`,
          timeoutMs,
        );
      }
      throw new ProviderError(
        config.providerId,
        "transport_error",
        `Could not reach ${config.providerId}.`,
        { cause: error, retryable: true },
      );
    }
  };

  return breaker.execute(() =>
    withRetry(attempt, {
      policy: retryPolicy,
      signal: request.signal,
      isRetryable: (error) => error instanceof PlatformError && error.retryable,
    }),
  );
}
