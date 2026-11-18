import type { AuthUser, PlatformClient } from "@freebuff/sdk";

import { anonClient } from "../api";
import type { ConfigStore } from "../config";

export interface SignInOptions {
  readonly store: ConfigStore;
  readonly email: string;
  /** Injected in tests; defaults to an unauthenticated client from stored config. */
  readonly client?: PlatformClient;
}

export interface SignInResult {
  readonly user: AuthUser;
  readonly token: string;
  readonly isNewUser: boolean;
}

/**
 * Sign-in for the CLI. Phase 2 uses the platform's local account flow; Phase 3 replaces the
 * credential exchange with OAuth while keeping this function's contract and token storage.
 */
export async function signIn(options: SignInOptions): Promise<SignInResult> {
  const client = options.client ?? anonClient(options.store);
  const email = options.email.trim().toLowerCase();
  if (!email.includes("@")) throw new Error("Enter a valid email address to sign in.");

  const result = await client.auth.login(email);
  options.store.write({
    platformUrl: client.baseUrl,
    token: result.token,
    userId: result.user.id,
    email: result.user.email,
  });

  return { user: result.user, token: result.token, isNewUser: result.isNewUser };
}
