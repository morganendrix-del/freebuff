import type { JsonObject, JsonSchema, JsonSchemaType, JsonValue } from "@freebuff/shared";

export interface ValidationResult {
  readonly ok: boolean;
  readonly errors: readonly string[];
}

function typeOfValue(value: unknown): JsonSchemaType {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  switch (typeof value) {
    case "string":
      return "string";
    case "number":
      return Number.isInteger(value) ? "integer" : "number";
    case "boolean":
      return "boolean";
    case "object":
      return "object";
    default:
      return "null";
  }
}

function matchesType(value: unknown, expected: JsonSchemaType): boolean {
  const actual = typeOfValue(value);
  if (expected === "number") return actual === "number" || actual === "integer";
  return actual === expected;
}

/**
 * Deterministic validator for the JSON-Schema subset the tools declare. Deliberately small: only the
 * keywords the platform actually emits are supported, so behaviour is predictable across providers.
 */
export function validateJsonSchema(
  value: unknown,
  schema: JsonSchema,
  path = "$",
): ValidationResult {
  const errors: string[] = [];

  if (schema.type !== undefined) {
    // Normalise through `unknown`: Array.isArray does not narrow readonly arrays.
    const declaredType: unknown = schema.type;
    const expected: readonly JsonSchemaType[] = Array.isArray(declaredType)
      ? (declaredType as readonly JsonSchemaType[])
      : [schema.type as JsonSchemaType];
    if (!expected.some((type) => matchesType(value, type))) {
      return {
        ok: false,
        errors: [`${path}: expected ${expected.join(" or ")}, received ${typeOfValue(value)}`],
      };
    }
  }

  if (schema.enum !== undefined) {
    const allowed = schema.enum;
    if (!allowed.some((candidate) => JSON.stringify(candidate) === JSON.stringify(value))) {
      errors.push(`${path}: value is not one of the allowed options`);
    }
  }

  if (typeof value === "string") {
    if (schema.minLength !== undefined && value.length < schema.minLength) {
      errors.push(`${path}: must be at least ${String(schema.minLength)} characters`);
    }
    if (schema.maxLength !== undefined && value.length > schema.maxLength) {
      errors.push(`${path}: must be at most ${String(schema.maxLength)} characters`);
    }
    if (schema.pattern !== undefined) {
      try {
        if (!new RegExp(schema.pattern).test(value)) {
          errors.push(`${path}: does not match the required pattern`);
        }
      } catch {
        errors.push(`${path}: schema pattern is invalid`);
      }
    }
  }

  if (typeof value === "number") {
    if (schema.minimum !== undefined && value < schema.minimum) {
      errors.push(`${path}: must be >= ${String(schema.minimum)}`);
    }
    if (schema.maximum !== undefined && value > schema.maximum) {
      errors.push(`${path}: must be <= ${String(schema.maximum)}`);
    }
  }

  const itemSchema = schema.items;
  if (itemSchema !== undefined && Array.isArray(value)) {
    value.forEach((item, index) => {
      const nested = validateJsonSchema(item, itemSchema, `${path}[${String(index)}]`);
      errors.push(...nested.errors);
    });
  }

  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;

    for (const required of schema.required ?? []) {
      if (!(required in record)) errors.push(`${path}.${required}: required property is missing`);
    }

    for (const [key, propertySchema] of Object.entries(schema.properties ?? {})) {
      if (!(key in record)) continue;
      const nested = validateJsonSchema(record[key], propertySchema, `${path}.${key}`);
      errors.push(...nested.errors);
    }

    if (schema.additionalProperties === false && schema.properties !== undefined) {
      const known = new Set(Object.keys(schema.properties));
      for (const key of Object.keys(record)) {
        if (!known.has(key)) errors.push(`${path}.${key}: unexpected property`);
      }
    }
  }

  return { ok: errors.length === 0, errors };
}

export function asJsonObject(value: unknown): JsonObject | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as JsonObject)
    : undefined;
}

export function jsonValueEquals(left: JsonValue, right: JsonValue): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}
