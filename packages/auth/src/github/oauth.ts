import { ConfigurationError } from "@freebuff/shared";

import { codeChallengeFor, createCodeVerifier } from "./app-jwt";
import type { FetchLike } from "./client";
import { GitHubError } from "./errors";

const AUTHORIZE_URL = "https://github.com/login/oauth/authorize";
const TOKEN_URL = "https://github.com/login/oauth/access_token";
const DEFAULT_SCOPES: readonly string[] = ["read:user", "user:email"];

export interface GitHubOAuthConfig {
  readonly clientId: string;
  readonly clientSecret: string;
  readonly redirectUri: string;
  readonly scopes?: readonly string[];
  readonly authorizeUrl?: string;
  readonly tokenUrl?: string;
}

export interface PkcePair {
  readonly verifier: string;
  readonly challenge: string;
}

export function createPkcePair(verifier: string = createCodeVerifier()): PkcePair {
  return { verifier, challenge: codeChallengeFor(verifier) };
}

export interface AuthorizeUrlInput {
  readonly state: string;
  readonly codeChallenge: string;
}

function assertConfig(config: GitHubOAuthConfig): void {
  if (config.clientId.trim() === "" || config.clientSecret.trim() === "") {
    throw new ConfigurationError("GitHub OAuth requires a client id and client secret.");
  }
  if (!URL.canParse(config.redirectUri)) {
    throw new ConfigurationError("GitHub OAuth requires an absolute redirect URI.");
  }
}

/** Builds the consent URL. The state and PKCE challenge are required, never optional. */
export function buildAuthorizeUrl(config: GitHubOAuthConfig, input: AuthorizeUrlInput): string {
  assertConfig(config);
  if (input.state.trim() === "" || input.codeChallenge.trim() === "") {
    throw new ConfigurationError("GitHub OAuth requires a state and a PKCE challenge.");
  }

  const url = new URL(config.authorizeUrl ?? AUTHORIZE_URL);
  url.searchParams.set("client_id", config.clientId);
  url.searchParams.set("redirect_uri", config.redirectUri);
  url.searchParams.set("scope", (config.scopes ?? DEFAULT_SCOPES).join(" "));
  url.searchParams.set("state", input.state);
  url.searchParams.set("code_challenge", input.codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  return url.toString();
}

/** Constant-time-ish comparison for the OAuth state round trip. */
export function assertOAuthState(expected: string, received: string | null): void {
  if (received === null || expected.length === 0 || received.length !== expected.length) {
    throw new GitHubError("bad_credentials", "OAuth state mismatch; restart the sign-in.", {
      status: 400,
    });
  }
  let mismatch = 0;
  for (let index = 0; index < expected.length; index += 1) {
    mismatch |= expected.charCodeAt(index) ^ received.charCodeAt(index);
  }
  if (mismatch !== 0) {
    throw new GitHubError("bad_credentials", "OAuth state mismatch; restart the sign-in.", {
      status: 400,
    });
  }
}

export interface TokenExchangeInput {
  readonly code: string;
  readonly codeVerifier: string;
  readonly fetchImpl?: FetchLike;
  readonly timeoutMs?: number;
}

export interface GitHubToken {
  readonly accessToken: string;
  readonly tokenType: string;
  readonly scope: string;
}

interface TokenPayload {
  readonly access_token?: unknown;
  readonly token_type?: unknown;
  readonly scope?: unknown;
  readonly error?: unknown;
  readonly error_description?: unknown;
}

/**
 * Exchanges an authorization code for a user token. Uses PKCE and the client secret, and sends
 * `Accept: application/json` so GitHub answers with JSON instead of a form body.
 */
export async function exchangeCodeForToken(
  config: GitHubOAuthConfig,
  input: TokenExchangeInput,
): Promise<GitHubToken> {
  assertConfig(config);
  if (input.code.trim() === "" || input.codeVerifier.trim() === "") {
    throw new GitHubError("bad_credentials", "Missing OAuth code or PKCE verifier.", {
      status: 400,
    });
  }

  const body = new URLSearchParams({
    client_id: config.clientId,
    client_secret: config.clientSecret,
    code: input.code,
    code_verifier: input.codeVerifier,
    redirect_uri: config.redirectUri,
  });

  const fetchImpl: FetchLike = input.fetchImpl ?? ((url, init) => globalThis.fetch(url, init));
  const response = await fetchImpl(config.tokenUrl ?? TOKEN_URL, {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/x-www-form-urlencoded",
      "user-agent": "freebuff-cloud/0.1",
    },
    body: body.toString(),
    signal: AbortSignal.timeout(input.timeoutMs ?? 15_000),
  });

  const text = await response.text();
  let payload: TokenPayload;
  try {
    payload = JSON.parse(text) as TokenPayload;
  } catch (error) {
    throw new GitHubError("invalid_response", "GitHub returned a malformed token response.", {
      status: response.status,
      cause: error,
    });
  }

  if (typeof payload.error === "string") {
    const description =
      typeof payload.error_description === "string" ? payload.error_description : payload.error;
    throw new GitHubError(
      "bad_credentials",
      `GitHub rejected the authorization code: ${description}`,
      {
        status: response.status,
      },
    );
  }

  if (!response.ok) throw GitHubError.fromStatus(response.status);
  if (typeof payload.access_token !== "string" || payload.access_token === "") {
    throw new GitHubError("invalid_response", "GitHub returned no access token.", {
      status: response.status,
    });
  }

  return {
    accessToken: payload.access_token,
    tokenType: typeof payload.token_type === "string" ? payload.token_type : "bearer",
    scope: typeof payload.scope === "string" ? payload.scope : "",
  };
}
