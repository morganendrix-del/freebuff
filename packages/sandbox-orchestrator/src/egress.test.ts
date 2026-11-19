import { describe, expect, test } from "vitest";

import { DENY_ALL_EGRESS, egressEnvironment, isEgressAllowed, parseEgressHost } from "./egress";

describe("egress policy", () => {
  test("deny_all beats every rule", () => {
    expect(
      isEgressAllowed(
        { mode: "deny_all", allow: [{ host: "registry.npmjs.org", ports: [443] }] },
        "registry.npmjs.org",
        443,
      ),
    ).toBe(false);
  });

  test("an empty allowlist denies everything", () => {
    expect(isEgressAllowed({ mode: "allowlist", allow: [] }, "example.com", 443)).toBe(false);
  });

  test("matches hosts and ports exactly, and supports subdomain wildcards", () => {
    const policy = {
      mode: "allowlist" as const,
      allow: [
        { host: "registry.npmjs.org", ports: [443] },
        { host: "*.githubusercontent.com", ports: [443] },
      ],
    };

    expect(isEgressAllowed(policy, "registry.npmjs.org", 443)).toBe(true);
    expect(isEgressAllowed(policy, "registry.npmjs.org", 80)).toBe(false);
    expect(isEgressAllowed(policy, "evil-registry.npmjs.org", 443)).toBe(false);
    expect(isEgressAllowed(policy, "raw.githubusercontent.com", 443)).toBe(true);
    expect(isEgressAllowed(policy, "githubusercontent.com", 443)).toBe(false);
  });

  test("open mode allows everything", () => {
    expect(isEgressAllowed({ mode: "open", allow: [] }, "example.com", 443)).toBe(true);
  });

  test("clears proxy variables for deny_all and sets both cases for allowlist", () => {
    const denied = egressEnvironment(DENY_ALL_EGRESS, "http://127.0.0.1:8888");
    expect(denied.HTTP_PROXY).toBe("");
    expect(denied.HTTPS_PROXY).toBe("");

    const allowed = egressEnvironment({ mode: "allowlist", allow: [] }, "http://127.0.0.1:8888");
    expect(allowed.HTTP_PROXY).toBe("http://127.0.0.1:8888");
    expect(allowed.no_proxy).toBe("");
  });

  test("parses wildcard hosts", () => {
    expect(parseEgressHost("*.Example.com")).toEqual({ hostname: "example.com", wildcard: true });
    expect(parseEgressHost("example.com")).toEqual({ hostname: "example.com", wildcard: false });
  });
});
