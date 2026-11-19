import type { IsoTimestamp } from "@freebuff/shared";

import { createAppJwt } from "./app-jwt";
import type { GitHubClient, GitHubInstallation, GitHubRepository } from "./client";
import { GitHubError } from "./errors";

export interface GitHubAppCredentials {
  readonly appId: string | number;
  readonly privateKeyPem: string;
}

export interface InstallationToken {
  readonly token: string;
  readonly expiresAt: IsoTimestamp;
}

/**
 * Exchanges an app JWT for a one-hour installation token. The token is scoped to the installation's
 * repositories by GitHub; this module never widens it and never persists it.
 */
export async function createInstallationToken(
  client: GitHubClient,
  credentials: GitHubAppCredentials,
  installationId: number,
  now = Date.now(),
): Promise<InstallationToken> {
  if (!Number.isInteger(installationId) || installationId <= 0) {
    throw new GitHubError("bad_credentials", "Invalid GitHub installation id.", { status: 400 });
  }

  const { jwt } = createAppJwt({
    appId: credentials.appId,
    privateKeyPem: credentials.privateKeyPem,
    now,
  });

  const payload = await client.request<unknown>(
    `/app/installations/${String(installationId)}/access_tokens`,
    { method: "POST", token: jwt, body: {} },
  );

  if (typeof payload !== "object" || payload === null) {
    throw new GitHubError("invalid_response", "GitHub returned no installation token.", {
      status: 201,
    });
  }

  const record = payload as { token?: unknown; expires_at?: unknown };
  if (typeof record.token !== "string" || record.token === "") {
    throw new GitHubError("invalid_response", "GitHub returned no installation token.", {
      status: 201,
    });
  }

  const expiresAt =
    typeof record.expires_at === "string" && Number.isFinite(Date.parse(record.expires_at))
      ? record.expires_at
      : new Date(now + 60 * 60 * 1_000).toISOString();

  return { token: record.token, expiresAt };
}

export async function listAppInstallations(
  client: GitHubClient,
  credentials: GitHubAppCredentials,
  now = Date.now(),
): Promise<readonly GitHubInstallation[]> {
  const { jwt } = createAppJwt({
    appId: credentials.appId,
    privateKeyPem: credentials.privateKeyPem,
    now,
  });
  return await client.listInstallations(jwt);
}

export async function listRepositoriesForInstallation(
  client: GitHubClient,
  token: string,
): Promise<readonly GitHubRepository[]> {
  return await client.listInstallationRepositories(token);
}
