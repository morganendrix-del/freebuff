import { createHash, createSign } from "node:crypto";

/**
 * GitHub App authentication.
 *
 * A GitHub App authenticates as itself with a short-lived RS256 JWT (`iss` = app id), then exchanges
 * that JWT for a one-hour installation token scoped to one installation. Both are credentials: they
 * live in memory only and never appear in URLs, logs or error messages.
 */

function base64UrlEncode(input: Buffer | string): string {
  return Buffer.from(input).toString("base64url");
}

export interface AppJwtInput {
  readonly appId: string | number;
  readonly privateKeyPem: string;
  readonly now?: number;
  /** GitHub rejects JWTs valid for more than 10 minutes. */
  readonly ttlSeconds?: number;
}

export interface AppJwt {
  readonly jwt: string;
  readonly issuedAt: number;
  readonly expiresAt: number;
}

export function createAppJwt(input: AppJwtInput): AppJwt {
  const issuedAt = Math.floor((input.now ?? Date.now()) / 1_000) - 60;
  const ttl = Math.min(input.ttlSeconds ?? 600, 600);
  const expiresAt = issuedAt + ttl;

  const header = base64UrlEncode(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = base64UrlEncode(
    JSON.stringify({ iat: issuedAt, exp: expiresAt, iss: input.appId }),
  );
  const signingInput = `${header}.${payload}`;

  const signer = createSign("RSA-SHA256");
  signer.update(signingInput);
  signer.end();
  const signature = signer.sign(input.privateKeyPem);

  return { jwt: `${signingInput}.${base64UrlEncode(signature)}`, issuedAt, expiresAt };
}

/** PKCE helper: S256 challenge for a generated or supplied verifier. */
export function createCodeVerifier(bytes = 32): string {
  if (bytes < 32 || bytes > 96) {
    throw new Error("A PKCE verifier must be between 32 and 96 bytes of entropy.");
  }
  return Buffer.from(globalThis.crypto.getRandomValues(new Uint8Array(bytes))).toString(
    "base64url",
  );
}

export function codeChallengeFor(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}
