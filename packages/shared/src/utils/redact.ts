/**
 * Redaction for anything that leaves a process boundary (logs, telemetry, error reports).
 *
 * Spec rule §6.4: never log prompts, source code or credentials. This module is the single choke
 * point; over-redaction is intentional and safe.
 */

const REDACTED = "[REDACTED]";
const MAX_DEPTH = 6;
const MAX_STRING_LENGTH = 1_000;

/** Keys that always hold credentials or session material. Matched on a normalized key. */
const CREDENTIAL_TOKENS: readonly string[] = [
  "accesstoken",
  "apikey",
  "authorization",
  "bearer",
  "cookie",
  "credential",
  "otp",
  "passwd",
  "password",
  "privatekey",
  "refreshtoken",
  "secret",
  "sessionkey",
  "token",
];

/** Keys that always hold user payload (prompts, code, transcripts). Matched exactly. */
const PAYLOAD_KEYS: ReadonlySet<string> = new Set([
  "content",
  "contents",
  "diff",
  "filecontent",
  "filecontents",
  "messages",
  "patch",
  "prompt",
  "prompts",
  "source",
  "sourcediff",
  "transcript",
]);

function normalizeKey(key: string): string {
  return key.toLowerCase().replaceAll(/[^a-z0-9]/g, "");
}

export function isSensitiveKey(key: string): boolean {
  const normalized = normalizeKey(key);
  if (PAYLOAD_KEYS.has(normalized)) return true;
  return CREDENTIAL_TOKENS.some((token) => normalized.includes(token));
}

export interface RedactionOptions {
  readonly replacement?: string;
  readonly maxDepth?: number;
  readonly maxStringLength?: number;
  readonly extraSensitiveKeys?: readonly string[];
}

/** Reads an own property without letting a hostile getter throw out of the redactor. */
function readProperty(input: object, key: string): unknown {
  try {
    return (input as Record<string, unknown>)[key];
  } catch {
    return "[Unreadable]";
  }
}

/** Returns a structurally-similar value that is safe to serialize. Cycles become `[Circular]`. */
export function redact(value: unknown, options: RedactionOptions = {}): unknown {
  const replacement = options.replacement ?? REDACTED;
  const maxDepth = options.maxDepth ?? MAX_DEPTH;
  const maxStringLength = options.maxStringLength ?? MAX_STRING_LENGTH;
  const extraSensitiveKeys = options.extraSensitiveKeys ?? [];
  const seen = new WeakSet<object>();

  const visit = (input: unknown, depth: number): unknown => {
    if (input === null) return null;

    switch (typeof input) {
      case "string":
        return input.length > maxStringLength
          ? `${input.slice(0, maxStringLength)}…[truncated ${String(input.length - maxStringLength)} chars]`
          : input;
      case "number":
      case "boolean":
        return input;
      case "bigint":
        return input.toString();
      case "undefined":
        return "[undefined]";
      case "symbol":
        return input.toString();
      case "function":
        return "[Function]";
      case "object":
        break;
    }

    if (input instanceof Date) return input.toISOString();
    if (input instanceof Error) {
      return { name: input.name, message: visit(input.message, depth + 1) };
    }
    if (depth >= maxDepth) return "[MaxDepth]";
    if (seen.has(input)) return "[Circular]";
    seen.add(input);

    if (Array.isArray(input)) return input.map((item) => visit(item, depth + 1));
    if (input instanceof Map) {
      const entries: Record<string, unknown> = {};
      for (const [key, item] of input) {
        const label = String(key);
        entries[label] = isSensitiveKey(label) ? replacement : visit(item, depth + 1);
      }
      return entries;
    }
    if (input instanceof Set) return [...input].map((item) => visit(item, depth + 1));

    const output: Record<string, unknown> = {};
    for (const key of Object.keys(input)) {
      const value = readProperty(input, key);
      const safeValue =
        isSensitiveKey(key) || extraSensitiveKeys.includes(key)
          ? replacement
          : visit(value, depth + 1);
      // defineProperty keeps hostile keys such as "__proto__" as plain own properties instead of
      // letting them mutate the prototype chain of the redacted record.
      Object.defineProperty(output, key, {
        value: safeValue,
        enumerable: true,
        configurable: true,
        writable: true,
      });
    }
    return output;
  };

  return visit(value, 0);
}
