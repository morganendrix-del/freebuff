import { createVerify, generateKeyPairSync } from "node:crypto";

import { describe, expect, test } from "vitest";

import {
  GitHubClient,
  GitHubError,
  assertOAuthState,
  buildAuthorizeUrl,
  codeChallengeFor,
  createAppJwt,
  createCodeVerifier,
  createInstallationToken,
  createPkcePair,
  exchangeCodeForToken,
  listAppInstallations,
} from "../src/index";

const config = {
  clientId: "client-123",
  clientSecret: "secret-456",
  redirectUri: "https://cloud.example.com/auth/github/callback",
  scopes: ["read:user", "repo"],
};

interface RecordedCall {
  readonly url: string;
  readonly init: RequestInit;
}

function fakeFetch(handler: (call: RecordedCall) => Response): {
  fetchImpl: (url: string, init: RequestInit) => Promise<Response>;
  calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];
  return {
    calls,
    fetchImpl: async (url, init) => {
      const call = { url, init };
      calls.push(call);
      return handler(call);
    },
  };
}

describe("github oauth", () => {
  test("derives the PKCE challenge from the verifier", () => {
    const pair = createPkcePair();
    expect(pair.challenge).toBe(codeChallengeFor(pair.verifier));
    expect(pair.challenge).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(createCodeVerifier()).not.toBe(createCodeVerifier());
  });

  test("builds a consent URL with state, scopes and S256", () => {
    const url = new URL(
      buildAuthorizeUrl(config, { state: "state-1", codeChallenge: "challenge-1" }),
    );

    expect(url.origin + url.pathname).toBe("https://github.com/login/oauth/authorize");
    expect(url.searchParams.get("client_id")).toBe("client-123");
    expect(url.searchParams.get("redirect_uri")).toBe(config.redirectUri);
    expect(url.searchParams.get("scope")).toBe("read:user repo");
    expect(url.searchParams.get("state")).toBe("state-1");
    expect(url.searchParams.get("code_challenge")).toBe("challenge-1");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.toString()).not.toContain("secret-456");
  });

  test("rejects a mismatched or missing state", () => {
    expect(() => {
      assertOAuthState("abc", "abc");
    }).not.toThrow();
    expect(() => {
      assertOAuthState("abc", "abd");
    }).toThrow(GitHubError);
    expect(() => {
      assertOAuthState("abc", null);
    }).toThrow(/state mismatch/);
    expect(() => {
      assertOAuthState("abc", "abcd");
    }).toThrow(/state mismatch/);
  });

  test("exchanges the code with PKCE and the client secret", async () => {
    const { fetchImpl, calls } = fakeFetch(
      () =>
        new Response(
          JSON.stringify({ access_token: "gho_user", token_type: "bearer", scope: "repo" }),
          { status: 200 },
        ),
    );

    const token = await exchangeCodeForToken(config, {
      code: "code-1",
      codeVerifier: "verifier-1",
      fetchImpl,
    });

    expect(token).toEqual({ accessToken: "gho_user", tokenType: "bearer", scope: "repo" });
    const call = calls[0];
    expect(call?.init.method).toBe("POST");
    const rawBody = call?.init.body;
    expect(typeof rawBody).toBe("string");
    const body = new URLSearchParams(typeof rawBody === "string" ? rawBody : "");
    expect(body.get("code")).toBe("code-1");
    expect(body.get("code_verifier")).toBe("verifier-1");
    expect(body.get("client_secret")).toBe("secret-456");
  });

  test("maps an OAuth error payload to a credential failure without echoing secrets", async () => {
    const { fetchImpl } = fakeFetch(
      () =>
        new Response(
          JSON.stringify({
            error: "bad_verification_code",
            error_description: "The code passed is incorrect or expired.",
          }),
          { status: 200 },
        ),
    );

    const failure = await exchangeCodeForToken(config, {
      code: "wrong",
      codeVerifier: "verifier-1",
      fetchImpl,
    }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(GitHubError);
    expect((failure as GitHubError).code).toBe("bad_credentials");
    expect((failure as Error).message).toContain("incorrect or expired");
    expect((failure as Error).message).not.toContain("secret-456");
  });
});

describe("github app authentication", () => {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const privateKeyPem = privateKey.export({ type: "pkcs1", format: "pem" });

  test("signs a verifiable RS256 JWT with the app id as issuer", () => {
    const { jwt, issuedAt, expiresAt } = createAppJwt({
      appId: "42",
      privateKeyPem,
      now: 1_700_000_000_000,
    });

    const [header, payload, signature] = jwt.split(".");
    expect(header).toBeDefined();
    expect(payload).toBeDefined();
    expect(signature).toBeDefined();

    const verifier = createVerify("RSA-SHA256");
    verifier.update(`${header ?? ""}.${payload ?? ""}`);
    verifier.end();
    expect(verifier.verify(publicKey, Buffer.from(signature ?? "", "base64url"))).toBe(true);

    const claims = JSON.parse(Buffer.from(payload ?? "", "base64url").toString("utf8")) as {
      iss: string;
      iat: number;
      exp: number;
    };
    expect(claims.iss).toBe("42");
    expect(claims.iat).toBe(issuedAt);
    expect(expiresAt - issuedAt).toBe(600);
  });

  test("exchanges the app JWT for a scoped installation token", async () => {
    const { fetchImpl, calls } = fakeFetch(
      () =>
        new Response(
          JSON.stringify({
            token: "ghs_installation",
            expires_at: "2026-11-19T20:00:00Z",
          }),
          { status: 201 },
        ),
    );
    const client = new GitHubClient({ fetchImpl });

    const token = await createInstallationToken(
      client,
      { appId: "42", privateKeyPem },
      99,
      1_700_000_000_000,
    );

    expect(token).toEqual({ token: "ghs_installation", expiresAt: "2026-11-19T20:00:00Z" });
    const call = calls[0];
    expect(call?.url).toMatch(/\/app\/installations\/99\/access_tokens$/);
    expect(call?.init.method).toBe("POST");
    const authorization = (call?.init.headers as Record<string, string>).authorization ?? "";
    expect(authorization.startsWith("Bearer eyJ")).toBe(true);
    expect(authorization).not.toContain("PRIVATE KEY");
  });

  test("lists the app's installations with the JWT", async () => {
    const { fetchImpl, calls } = fakeFetch(
      () => new Response(JSON.stringify([{ id: 7, account: { login: "acme" } }]), { status: 200 }),
    );
    const client = new GitHubClient({ fetchImpl });

    const installations = await listAppInstallations(client, { appId: "42", privateKeyPem });

    expect(installations).toEqual([{ id: 7, account: { login: "acme" } }]);
    expect(calls[0]?.url).toContain("/app/installations");
  });
});

describe("github client", () => {
  test("retries idempotent failures and returns the parsed body", async () => {
    let attempt = 0;
    const { fetchImpl, calls } = fakeFetch(() => {
      attempt += 1;
      return attempt === 1
        ? new Response("upstream boom", { status: 503 })
        : new Response(JSON.stringify({ full_name: "acme/demo", clone_url: "https://x" }), {
            status: 200,
          });
    });
    const client = new GitHubClient({
      fetchImpl,
      retryPolicy: { maxAttempts: 2, baseDelayMs: 0, maxDelayMs: 0, jitterRatio: 0 },
    });

    const repo = await client.getRepository("acme", "demo");

    expect(repo.full_name).toBe("acme/demo");
    expect(calls).toHaveLength(2);
    expect(calls[0]?.init.headers).toMatchObject({
      "user-agent": "freebuff-cloud/0.1",
      "x-github-api-version": "2022-11-28",
    });
  });

  test("does not retry a 401 and never includes the token in the message", async () => {
    const { fetchImpl, calls } = fakeFetch(() => new Response("{}", { status: 401 }));
    const client = new GitHubClient({
      token: "gho_secret_token",
      fetchImpl,
      retryPolicy: { maxAttempts: 3, baseDelayMs: 0, maxDelayMs: 0, jitterRatio: 0 },
    });

    const failure = await client.getRepository("acme", "demo").catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(GitHubError);
    expect((failure as GitHubError).code).toBe("bad_credentials");
    expect((failure as Error).message).not.toContain("gho_secret_token");
    expect(calls).toHaveLength(1);
    expect((calls[0]?.init.headers as Record<string, string>).authorization).toBe(
      "Bearer gho_secret_token",
    );
  });

  test("maps 404 to not_found", async () => {
    const { fetchImpl } = fakeFetch(
      () => new Response("{}", { status: 404, headers: { "x-github-request-id": "req-1" } }),
    );
    const client = new GitHubClient({ fetchImpl });

    const failure = await client.getRepository("acme", "missing").catch((error: unknown) => error);

    expect((failure as GitHubError).code).toBe("not_found");
    expect((failure as GitHubError).requestId).toBe("req-1");
  });
});
