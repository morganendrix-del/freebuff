import { PlatformError } from "@freebuff/shared";
import type { QuotaDecision } from "@freebuff/shared";

export type QuotaDenial = Extract<QuotaDecision, { readonly allowed: false }>;

/** The account is out of free hours; the message is safe to show verbatim. */
export class QuotaDeniedError extends PlatformError {
  readonly denial: QuotaDenial;

  constructor(denial: QuotaDenial) {
    super("quota_exhausted", denial.message, { details: { resetsAt: denial.resetsAt } });
    this.name = "QuotaDeniedError";
    this.denial = denial;
  }
}

/** No stored token: the caller must sign in before a run can start. */
export class NotAuthenticatedError extends PlatformError {
  constructor(message = "Not signed in. Run `freebuff login <email>` first.") {
    super("unauthorized", message);
    this.name = "NotAuthenticatedError";
  }
}
