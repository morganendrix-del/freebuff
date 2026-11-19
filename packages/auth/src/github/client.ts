import { DEFAULT_RETRY_POLICY, withRetry, withTimeout } from "@freebuff/shared";
import type { RetryPolicy } from "@freebuff/shared";

import { GitHubError } from "./errors";

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

const DEFAULT_BASE_URL = "https://api.github.com";
const DEFAULT_TIMEOUT_MS = 15_000;
const USER_AGENT = "freebuff-cloud/0.1";

export interface GitHubClientOptions {
  /** Token for the call: OAuth user token, app JWT or installation token. */
  readonly token?: string;
  readonly baseUrl?: string;
  readonly fetchImpl?: FetchLike;
  readonly timeoutMs?: number;
  readonly retryPolicy?: RetryPolicy;
}

export interface RequestOptions {
  readonly method?: "DELETE" | "GET" | "POST" | "PUT";
  readonly body?: unknown;
  readonly token?: string;
  readonly accept?: string;
  readonly retryable?: boolean;
}

export interface GitHubRepository {
  readonly id: number;
  readonly full_name: string;
  readonly default_branch: string;
  readonly private: boolean;
  readonly clone_url: string;
  readonly html_url: string;
}

export interface GitHubInstallation {
  readonly id: number;
  readonly account: { readonly login: string; readonly type?: string } | null;
}

function asObject(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/**
 * Thin GitHub REST client: token handling, timeout, bounded retries for idempotent calls, and
 * status-to-error mapping. Credentials are only ever placed in the Authorization header and are
 * excluded from every error message.
 */
export class GitHubClient {
  readonly #token: string | undefined;
  readonly #baseUrl: string;
  readonly #fetch: FetchLike;
  readonly #timeoutMs: number;
  readonly #retryPolicy: RetryPolicy;

  constructor(options: GitHubClientOptions = {}) {
    this.#token = options.token;
    this.#baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.#fetch = options.fetchImpl ?? ((input, init) => globalThis.fetch(input, init));
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.#retryPolicy = options.retryPolicy ?? DEFAULT_RETRY_POLICY;
  }

  async request<T>(path: string, options: RequestOptions = {}): Promise<T> {
    const retryable = options.retryable ?? (options.method ?? "GET") === "GET";
    if (!retryable) return await this.#attempt<T>(path, options);

    return await withRetry(() => this.#attempt<T>(path, options), {
      policy: this.#retryPolicy,
      isRetryable: (error: unknown) => error instanceof GitHubError && error.retryable,
    });
  }

  async #attempt<T>(path: string, options: RequestOptions): Promise<T> {
    const token = options.token ?? this.#token;
    const headers: Record<string, string> = {
      accept: options.accept ?? "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
      "user-agent": USER_AGENT,
    };
    if (token !== undefined) headers.authorization = `Bearer ${token}`;
    if (options.body !== undefined) headers["content-type"] = "application/json";

    let response: Response;
    try {
      response = await withTimeout(
        async (signal) =>
          await this.#fetch(`${this.#baseUrl}${path}`, {
            method: options.method ?? "GET",
            headers,
            signal,
            ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
          }),
        this.#timeoutMs,
        "The GitHub request timed out.",
      );
    } catch (error) {
      throw new GitHubError("unavailable", "GitHub is unreachable.", {
        status: 0,
        retryable: true,
        cause: error,
      });
    }

    const requestId = response.headers.get("x-github-request-id") ?? undefined;
    const text = await response.text();

    if (!response.ok) {
      throw GitHubError.fromStatus(response.status, requestId);
    }

    if (text.trim() === "") return undefined as T;
    try {
      return JSON.parse(text) as T;
    } catch (error) {
      throw new GitHubError("invalid_response", "GitHub returned malformed JSON.", {
        status: response.status,
        ...(requestId === undefined ? {} : { requestId }),
        cause: error,
      });
    }
  }

  async getRepository(owner: string, name: string): Promise<GitHubRepository> {
    const payload = await this.request<unknown>(
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`,
    );
    const repo = asObject(payload);
    if (
      repo === undefined ||
      typeof repo.full_name !== "string" ||
      typeof repo.clone_url !== "string"
    ) {
      throw new GitHubError("invalid_response", "Unexpected repository payload.", { status: 200 });
    }
    return payload as GitHubRepository;
  }

  async listInstallations(token?: string): Promise<readonly GitHubInstallation[]> {
    const payload = await this.request<unknown>("/app/installations?per_page=100", {
      ...(token === undefined ? {} : { token }),
    });
    if (!Array.isArray(payload)) {
      throw new GitHubError("invalid_response", "Unexpected installations payload.", {
        status: 200,
      });
    }
    return payload.filter((entry): entry is GitHubInstallation => asObject(entry) !== undefined);
  }

  async listInstallationRepositories(token: string): Promise<readonly GitHubRepository[]> {
    const payload = await this.request<unknown>(`/installation/repositories?per_page=100`, {
      token,
    });
    const body = asObject(payload);
    const repositories = body?.repositories;
    if (!Array.isArray(repositories)) {
      throw new GitHubError("invalid_response", "Unexpected repositories payload.", {
        status: 200,
      });
    }
    return repositories.filter((entry): entry is GitHubRepository => asObject(entry) !== undefined);
  }
}
