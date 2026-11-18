import type { ReactNode } from "react";

import type { AdSelection } from "@freebuff/shared";

export interface SponsoredSlotProps {
  readonly ad: AdSelection | null;
}

/**
 * Sponsored slot. The label comes from the creative and is rendered verbatim; paid tiers receive no
 * selection from the server, so this renders nothing for them.
 */
export function SponsoredSlot({ ad }: SponsoredSlotProps): ReactNode {
  if (ad === null) return null;

  return (
    <box borderStyle="rounded" borderColor="#3a3f44" padding={1} flexDirection="column">
      <box flexDirection="row" gap={1}>
        <text fg="#f2c14e">{ad.label}</text>
        <text fg="#9aa0a6">{ad.creative.sponsor}</text>
      </box>
      <text fg="#e8eaed">{ad.creative.headline}</text>
      <text fg="#6b7280">{ad.creative.displayUrl}</text>
    </box>
  );
}
