import { isJsonObject } from "@freebuff/shared";
import type { JsonObject, JsonValue, ProviderId } from "@freebuff/shared";

import { ProviderError } from "./errors";

export function asRecord(value: JsonValue | undefined): JsonObject | undefined {
  return value !== undefined && isJsonObject(value) ? value : undefined;
}

export function asArray(value: JsonValue | undefined): readonly JsonValue[] | undefined {
  return Array.isArray(value) ? value : undefined;
}

export function asString(value: JsonValue | undefined): string | undefined {
  return typeof value === "string" ? value : undefined;
}

export function asNumber(value: JsonValue | undefined): number | undefined {
  return typeof value === "number" ? value : undefined;
}

/** Parses one SSE `data:` payload, failing closed on malformed JSON. */
export function parseStreamPayload(providerId: ProviderId, data: string): JsonObject {
  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch (error) {
    throw new ProviderError(
      providerId,
      "malformed_stream",
      `${providerId} streamed a payload that is not JSON.`,
      { cause: error },
    );
  }

  if (!isJsonObject(parsed)) {
    throw new ProviderError(
      providerId,
      "malformed_stream",
      `${providerId} streamed a non-object payload.`,
    );
  }
  return parsed;
}

/** Tool arguments are opaque JSON strings on the wire; Anthropic wants them as an object. */
export function parseArgumentsObject(raw: string): JsonObject {
  if (raw.trim() === "") return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    return isJsonObject(parsed) ? parsed : {};
  } catch {
    return {};
  }
}
