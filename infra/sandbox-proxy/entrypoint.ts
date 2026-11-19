import { startEgressProxy } from "./proxy";
import type { EgressPolicy, EgressRule } from "@freebuff/shared";

/**
 * Container entrypoint for the egress proxy.
 *
 * `EGRESS_ALLOW` is JSON: `{"mode":"allowlist","allow":[{"host":"registry.npmjs.org","ports":[443]}]}`.
 * A missing or malformed policy starts the proxy in `deny_all` mode — the safe direction.
 */
function parsePolicy(raw: string | undefined): EgressPolicy {
  if (raw === undefined || raw.trim() === "") return { mode: "deny_all", allow: [] };

  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return { mode: "deny_all", allow: [] };
    const candidate = parsed as { mode?: unknown; allow?: unknown };
    const mode =
      candidate.mode === "open" || candidate.mode === "allowlist" || candidate.mode === "deny_all"
        ? candidate.mode
        : "deny_all";
    const allow: EgressRule[] = Array.isArray(candidate.allow)
      ? candidate.allow.flatMap((entry: unknown) => {
          if (typeof entry !== "object" || entry === null) return [];
          const rule = entry as { host?: unknown; ports?: unknown };
          if (typeof rule.host !== "string") return [];
          const ports = Array.isArray(rule.ports)
            ? rule.ports.filter((port: unknown): port is number => typeof port === "number")
            : [];
          return [{ host: rule.host, ports }];
        })
      : [];
    return { mode, allow };
  } catch {
    return { mode: "deny_all", allow: [] };
  }
}

const port = Number.parseInt(process.env.EGRESS_PROXY_PORT ?? "8888", 10);
const proxy = await startEgressProxy({
  policy: parsePolicy(process.env.EGRESS_ALLOW),
  port,
});

process.stdout.write(`${JSON.stringify({ event: "egress.proxy.ready", port: proxy.port })}\n`);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    void proxy.close().then(() => {
      process.exit(0);
    });
  });
}
