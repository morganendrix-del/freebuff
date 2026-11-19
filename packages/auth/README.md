# @freebuff/auth

Status: **GitHub delivered** (Phase 3). Magic links, phone OTP and generated-app OAuth follow in
Phases 4–5.

## GitHub

| Module                        | Purpose                                                                     |
| ----------------------------- | --------------------------------------------------------------------------- |
| `src/github/oauth.ts`         | Authorization-code flow with PKCE: consent URL, state check, token exchange |
| `src/github/app-jwt.ts`       | RS256 GitHub App JWT (`iss` = app id, ≤10 min) and PKCE helpers             |
| `src/github/installations.ts` | App JWT → one-hour installation token, installation and repository listing  |
| `src/github/client.ts`        | REST client: timeout, retries for idempotent calls, status → `GitHubError`  |
| `src/github/errors.ts`        | `bad_credentials`, `forbidden`, `not_found`, `rate_limited`, `unavailable`  |

```ts
const { verifier, challenge } = createPkcePair();
const url = buildAuthorizeUrl(config, { state, codeChallenge: challenge });
// … callback …
assertOAuthState(state, receivedState);
const { accessToken } = await exchangeCodeForToken(config, { code, codeVerifier: verifier });

const installation = await createInstallationToken(client, credentials, installationId);
```

Rules:

- Tokens live in memory only: never in URLs, argv, logs or error messages. `GitHubError` carries the
  status and request id, never the response body or credential.
- OAuth `state` and PKCE are required; a mismatch fails closed.
- Installation tokens are scoped by GitHub to one installation and expire in an hour.

## Environment

`GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, `GITHUB_OAUTH_REDIRECT_URL` for the user flow;
`GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY` for App JWT and installation tokens. All are validated by
`packages/shared/src/config/env.ts` and are optional until the feature is used.
