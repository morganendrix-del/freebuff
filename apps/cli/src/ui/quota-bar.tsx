import type { ReactNode } from "react";

import type { QuotaBarView } from "@freebuff/quota";

export interface QuotaBarProps {
  readonly view: QuotaBarView;
  readonly width?: number;
}

const FILLED = "█";
const EMPTY = "░";

/** Quota status bar. Renders the server snapshot only — it never computes access itself. */
export function QuotaBar({ view, width = 12 }: QuotaBarProps): ReactNode {
  const filled = Math.round(view.fill * width);
  const bar =
    FILLED.repeat(Math.min(width, Math.max(0, filled))) + EMPTY.repeat(Math.max(0, width - filled));

  return (
    <box flexDirection="row" gap={1}>
      <text fg={view.exhausted ? "#ff6b6b" : "#6bcb77"}>{bar}</text>
      <text fg="#9aa0a6">{view.text}</text>
    </box>
  );
}
