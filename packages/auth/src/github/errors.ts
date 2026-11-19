export type GitHubErrorCode =
  | "bad_credentials"
  | "forbidden"
  | "invalid_response"
  | "not_found"
  | "rate_limited"
  | "unavailable";

export interface GitHubErrorOptions {
  readonly status: number;
  readonly requestId?: string;
  readonly retryable?: boolean;
  readonly cause?: unknown;
}

/**
 * GitHub failure with the status and request id GitHub returned. Messages never include the
 * response body verbatim or any credential: they are safe to log and to surface to a user.
 */
export class GitHubError extends Error {
  readonly code: GitHubErrorCode;
  readonly status: number;
  readonly requestId: string | undefined;
  readonly retryable: boolean;

  constructor(code: GitHubErrorCode, message: string, options: GitHubErrorOptions) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "GitHubError";
    this.code = code;
    this.status = options.status;
    this.requestId = options.requestId;
    this.retryable = options.retryable ?? false;
  }

  static fromStatus(status: number, requestId?: string): GitHubError {
    const base = { status, ...(requestId === undefined ? {} : { requestId }) };
    switch (status) {
      case 401:
        return new GitHubError("bad_credentials", "GitHub rejected the credentials.", base);
      case 403:
        return new GitHubError("forbidden", "GitHub refused the request for this token.", base);
      case 404:
        return new GitHubError("not_found", "The repository or installation was not found.", base);
      case 429:
        return new GitHubError("rate_limited", "GitHub rate-limited the request.", {
          ...base,
          retryable: true,
        });
      default:
        return new GitHubError("unavailable", `GitHub returned status ${String(status)}.`, {
          ...base,
          retryable: status >= 500,
        });
    }
  }
}
