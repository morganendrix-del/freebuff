import { z } from "zod";

import { PlatformError } from "../utils/errors";

/**
 * Environment contract. Every secret is optional at the type level: a surface only fails when the
 * feature that needs a variable starts. Values are never logged or echoed; validation errors report
 * paths and reasons only.
 */
const emptyToUndefined = (value: unknown): unknown =>
  typeof value === "string" && value.trim() === "" ? undefined : value;

const optionalString = z.preprocess(emptyToUndefined, z.string().min(1).optional());
const optionalUrl = z.preprocess(emptyToUndefined, z.url().optional());
const optionalSecret = z.preprocess(emptyToUndefined, z.string().min(1).optional());

export const PLATFORM_ENV_SCHEMA = z.object({
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),

  DATABASE_URL: optionalUrl,
  CONVEX_URL: optionalUrl,
  SESSION_SECRET: z.preprocess(emptyToUndefined, z.string().min(32).optional()),

  DEEPSEEK_API_KEY: optionalSecret,
  OPENAI_API_KEY: optionalSecret,
  ANTHROPIC_API_KEY: optionalSecret,

  GITHUB_CLIENT_ID: optionalSecret,
  GITHUB_CLIENT_SECRET: optionalSecret,
  GITHUB_OAUTH_REDIRECT_URL: optionalUrl,

  TWILIO_ACCOUNT_SID: optionalSecret,
  TWILIO_AUTH_TOKEN: optionalSecret,
  TWILIO_FROM_NUMBER: optionalSecret,

  SANDBOX_HTTP_PORT: z.coerce.number().int().min(1024).max(65_535).default(8788),
  SANDBOX_IMAGE: z.string().min(1).default("freebuff/sandbox:local"),

  FREE_TIER_DAILY_HOURS_JSON: optionalString,
});

export type PlatformEnv = z.infer<typeof PLATFORM_ENV_SCHEMA>;

/** Formats validation failures without ever including a supplied value. */
export function formatEnvError(error: z.ZodError): string {
  const issues = error.issues.map((issue) => {
    const path = issue.path.length > 0 ? issue.path.join(".") : "(root)";
    return `${path}: ${issue.message}`;
  });
  return `Invalid environment configuration: ${issues.join("; ")}`;
}

export function loadEnv(
  source: Readonly<Record<string, string | undefined>> = process.env,
): PlatformEnv {
  const result = PLATFORM_ENV_SCHEMA.safeParse(source);
  if (!result.success) {
    throw new PlatformError("invalid_config", formatEnvError(result.error));
  }
  return result.data;
}

/** Reads a required variable that the schema deliberately keeps optional for other surfaces. */
export function requireEnvValue(env: PlatformEnv, key: keyof PlatformEnv): string {
  const value = env[key];
  if (typeof value !== "string" || value === "") {
    throw new PlatformError("invalid_config", `Missing required environment variable ${key}.`);
  }
  return value;
}
