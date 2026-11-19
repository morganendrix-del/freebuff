import type { EgressPolicy, EgressRule } from "@freebuff/shared";

export interface ParsedHost {
  readonly hostname: string;
  /** `*.example.com` allows any subdomain of example.com (not example.com itself). */
  readonly wildcard: boolean;
}

export function parseEgressHost(host: string): ParsedHost {
  const trimmed = host.trim().toLowerCase();
  if (trimmed.startsWith("*.")) {
    return { hostname: trimmed.slice(2), wildcard: true };
  }
  return { hostname: trimmed, wildcard: false };
}

function ruleMatches(rule: EgressRule, hostname: string, port: number | undefined): boolean {
  const parsed = parseEgressHost(rule.host);
  const target = hostname.toLowerCase();

  const hostMatches = parsed.wildcard
    ? target.endsWith(`.${parsed.hostname}`) && target !== parsed.hostname
    : target === parsed.hostname;
  if (!hostMatches) return false;

  // An empty port list means the rule covers every port.
  return rule.ports.length === 0 || port === undefined || rule.ports.includes(port);
}

/**
 * Single decision point for outbound access. `deny_all` wins over any rule, and an `allowlist` policy
 * with no rules denies everything — a partially configured policy can never fail open.
 */
export function isEgressAllowed(policy: EgressPolicy, hostname: string, port?: number): boolean {
  if (policy.mode === "open") return true;
  if (policy.mode === "deny_all") return false;
  return policy.allow.some((rule) => ruleMatches(rule, hostname, port));
}

/** Environment that points well-behaved clients (git, npm, curl) at the allowlist proxy. */
export function egressEnvironment(
  policy: EgressPolicy,
  proxyUrl: string | undefined,
): Record<string, string> {
  if (policy.mode === "deny_all" || proxyUrl === undefined) {
    return {
      HTTP_PROXY: "",
      HTTPS_PROXY: "",
      http_proxy: "",
      https_proxy: "",
      ALL_PROXY: "",
      NO_PROXY: "",
      no_proxy: "",
    };
  }
  return {
    HTTP_PROXY: proxyUrl,
    HTTPS_PROXY: proxyUrl,
    http_proxy: proxyUrl,
    https_proxy: proxyUrl,
    NO_PROXY: "",
    no_proxy: "",
  };
}

/** Default policy for installing dependencies from public package registries. */
export const PACKAGE_REGISTRY_EGRESS: EgressPolicy = {
  mode: "allowlist",
  allow: [
    { host: "registry.npmjs.org", ports: [443] },
    { host: "registry.yarnpkg.com", ports: [443] },
    { host: "github.com", ports: [443] },
    { host: "codeload.github.com", ports: [443] },
    { host: "objects.githubusercontent.com", ports: [443] },
  ],
};

export const DENY_ALL_EGRESS: EgressPolicy = { mode: "deny_all", allow: [] };
