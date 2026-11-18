import { SPONSORED_LABEL, createId, entitlementsFor } from "@freebuff/shared";
import type { AdCreative, AdSelection, AdTargetingContext, AdPosition } from "@freebuff/shared";

/**
 * Demo inventory for the local platform. Creatives are real data (label, sponsor, target), not
 * placeholder strings: the CLI renders exactly what the server selected. Phase 5 replaces the source,
 * not the contract.
 */
export const LOCAL_CREATIVES: readonly AdCreative[] = [
  {
    id: createId("ad"),
    sponsor: "Vercel",
    headline: "Ship your agent's app in one command",
    body: "Deploy the project you just built, with previews for every branch.",
    displayUrl: "vercel.com",
    targetUrl: "https://vercel.com",
    categories: ["deploy", "hosting"],
    label: SPONSORED_LABEL,
    eligibleTiers: ["free"],
    weight: 3,
    active: true,
  },
  {
    id: createId("ad"),
    sponsor: "Sentry",
    headline: "Know when the agent breaks production",
    body: "Error tracking with stack traces for generated apps and APIs.",
    displayUrl: "sentry.io",
    targetUrl: "https://sentry.io",
    categories: ["monitoring", "observability"],
    label: SPONSORED_LABEL,
    eligibleTiers: ["free"],
    weight: 2,
    active: true,
  },
  {
    id: createId("ad"),
    sponsor: "Postgres Pro",
    headline: "Managed Postgres for the apps you generate",
    body: "Backups, replicas and connection pooling without the ops work.",
    displayUrl: "postgrespro.com",
    targetUrl: "https://postgrespro.com",
    categories: ["database", "postgres"],
    label: SPONSORED_LABEL,
    eligibleTiers: ["free"],
    weight: 1,
    active: true,
  },
];

export interface SelectCreativeOptions {
  readonly context: AdTargetingContext;
  readonly position?: AdPosition;
  readonly inventory?: readonly AdCreative[];
  readonly random?: () => number;
}

/**
 * Server-side ad selection. Paid tiers get no slot; free tiers get a weighted pick among eligible,
 * active creatives. Targeting uses context tags only — the prompt itself never reaches this module.
 */
export function selectCreative(options: SelectCreativeOptions): AdSelection | null {
  if (!entitlementsFor(options.context.tier).adsEnabled) return null;

  const inventory = options.inventory ?? LOCAL_CREATIVES;
  const candidates = inventory.filter(
    (creative) => creative.active && creative.eligibleTiers.includes(options.context.tier),
  );
  if (candidates.length === 0) return null;

  const scored = candidates.map((creative) => ({
    creative,
    score:
      creative.weight *
      (1 + creative.categories.filter((tag) => options.context.contextTags.includes(tag)).length),
  }));
  const total = scored.reduce((sum, entry) => sum + entry.score, 0);
  const random = options.random ?? Math.random;
  let ticket = random() * total;
  let chosen = scored[scored.length - 1];
  for (const entry of scored) {
    ticket -= entry.score;
    if (ticket <= 0) {
      chosen = entry;
      break;
    }
  }
  if (chosen === undefined) return null;

  return {
    creative: chosen.creative,
    slot: {
      surface: options.context.surface,
      position: options.position ?? "between_turns",
      maxChars: 160,
    },
    label: SPONSORED_LABEL,
  };
}
