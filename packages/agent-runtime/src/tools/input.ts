import { PlatformError } from "@freebuff/shared";
import type { JsonObject } from "@freebuff/shared";

export function requireString(input: JsonObject, key: string): string {
  const value = input[key];
  if (typeof value !== "string" || value === "") {
    throw new PlatformError("invalid_input", `Argument "${key}" must be a non-empty string.`);
  }
  return value;
}

export function optionalString(input: JsonObject, key: string): string | undefined {
  const value = input[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string") {
    throw new PlatformError("invalid_input", `Argument "${key}" must be a string.`);
  }
  return value;
}

export function optionalNumber(input: JsonObject, key: string): number | undefined {
  const value = input[key];
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new PlatformError("invalid_input", `Argument "${key}" must be a finite number.`);
  }
  return value;
}

export function optionalBoolean(input: JsonObject, key: string): boolean | undefined {
  const value = input[key];
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") {
    throw new PlatformError("invalid_input", `Argument "${key}" must be a boolean.`);
  }
  return value;
}

export function requireArray(input: JsonObject, key: string): readonly JsonObject[] {
  const value = input[key];
  if (!Array.isArray(value)) {
    throw new PlatformError("invalid_input", `Argument "${key}" must be an array.`);
  }

  return value.map((item) => {
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      throw new PlatformError("invalid_input", `Argument "${key}" must contain objects.`);
    }
    return item;
  });
}
