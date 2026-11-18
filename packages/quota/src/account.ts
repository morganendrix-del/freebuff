import type { AgentTier, Id, IanaTimeZone } from "@freebuff/shared";

/** Everything the tracker needs to know about the account whose quota it is deciding. */
export interface QuotaAccount {
  readonly userId: Id<"user">;
  readonly tier: AgentTier;
  readonly countryCode: string;
  readonly timeZone: IanaTimeZone;
  readonly phoneVerified: boolean;
}
