# infra

Local development and deployment assets.

## Local stack

```bash
bun run infra:up      # Postgres 16 + sandbox runtime
bun run infra:down    # stop and remove
bun run infra:config  # validate the compose file (used by CI)
```

| Service    | Port        | Purpose                                                                   |
| ---------- | ----------- | ------------------------------------------------------------------------- |
| `postgres` | 5432        | Platform metadata (users, projects, quota, ad impressions, deployments).  |
| `sandbox`  | 8788 (HTTP) | Hardened agent execution boundary; `/health` and `/info` only in Phase 0. |

## Isolation model

Local containers are a development stand-in for the production boundary (see
`DECISIONS.md` D7). Both paths use the constraints encoded in the platform, not in the shell:

- read-only root filesystem, tmpfs workspace
- `cap_drop: ALL`, `no-new-privileges`, non-root user
- PID / memory / CPU limits, TTL enforced by `packages/sandbox-orchestrator`
- `SandboxSpec.egress` (`deny_all` default) mapped to an allowlist proxy or microVM host policy

Docker networking on a bridge is **not** an egress control; production never relies on it.

## Not yet here

`firecracker/` microVM definitions, Windows/macOS signing material (`signing/`) and Kubernetes
manifests land with their phases (3 and 5). No placeholder manifests ship ahead of the code that uses
them.
