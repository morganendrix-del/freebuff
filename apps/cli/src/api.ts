import { createPlatformClient } from "@freebuff/sdk";
import type { PlatformClient } from "@freebuff/sdk";

import type { ConfigStore } from "./config";

/** Builds a platform client from stored config. Missing tokens are surfaced, never defaulted. */
export function clientFromConfig(
  store: ConfigStore,
  overrides: { readonly baseUrl?: string; readonly token?: string } = {},
): PlatformClient {
  const config = store.read();
  const token = overrides.token ?? config.token;
  return createPlatformClient({
    baseUrl: overrides.baseUrl ?? config.platformUrl,
    ...(token === undefined ? {} : { token }),
  });
}

/** Client that is guaranteed to carry a token; throws the CLI's sign-in error otherwise. */
export function authenticatedClient(store: ConfigStore): PlatformClient {
  const token = store.requireToken();
  return clientFromConfig(store, { token });
}

export function anonClient(store: ConfigStore): PlatformClient {
  const config = store.read();
  return createPlatformClient({ baseUrl: config.platformUrl });
}
