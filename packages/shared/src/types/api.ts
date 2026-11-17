import type { Id } from "./ids";
import type { JsonValue } from "./json";
import type { AgentTier } from "./tier";

export type ApiErrorCode =
  | "conflict"
  | "forbidden"
  | "internal"
  | "invalid_request"
  | "not_found"
  | "payment_required"
  | "quota_exhausted"
  | "rate_limited"
  | "unauthorized"
  | "verification_required";

export interface ApiError {
  readonly code: ApiErrorCode;
  readonly message: string;
  readonly requestId: string;
  readonly details?: JsonValue;
}

export type ApiResponse<T> =
  { readonly ok: true; readonly data: T } | { readonly ok: false; readonly error: ApiError };

export interface Page<T> {
  readonly items: readonly T[];
  readonly nextCursor?: string;
}

/** Per-request identity, attached by the API layer after auth. */
export interface RequestContext {
  readonly requestId: string;
  readonly userId?: Id<"user">;
  readonly tier: AgentTier;
}
