/**
 * Opaque, prefixed identifiers. Branding stops a session id being passed where a project id belongs.
 */
declare const idBrand: unique symbol;

export type IdKind =
  "ad" | "agent" | "deployment" | "message" | "project" | "run" | "sandbox" | "session" | "user";

export type Id<K extends IdKind> = string & { readonly [idBrand]: K };

const SEPARATOR = "_";
const BODY_LENGTH = 32;
const BODY_PATTERN = /^[0-9a-f]{32}$/;

/** Creates a new branded id, e.g. `session_9f2c…`. */
export function createId<K extends IdKind>(kind: K): Id<K> {
  const body = globalThis.crypto.randomUUID().replaceAll("-", "");
  return `${kind}${SEPARATOR}${body}` as Id<K>;
}

/** Type guard for ids of a specific kind. */
export function isId<K extends IdKind>(kind: K, value: unknown): value is Id<K> {
  if (typeof value !== "string") return false;
  const prefix = `${kind}${SEPARATOR}`;
  if (!value.startsWith(prefix)) return false;
  const body = value.slice(prefix.length);
  return body.length === BODY_LENGTH && BODY_PATTERN.test(body);
}
