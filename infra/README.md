# infra

Local development and deployment assets.

## Local stack

```bash
bun run infra:up      # Postgres 16 + sandbox runtime + egress proxy
bun run infra:down    # stop and remove
bun run infra:config  # validate the compose file (used by CI)

bun run cloud         # sandbox API + dashboard on http://127.0.0.1:8790
```

| Service         | Port        | Purpose                                                                  |
| --------------- | ----------- | ------------------------------------------------------------------------ |
| `postgres`      | 5432        | Platform metadata (users, projects, quota, ad impressions, deployments). |
| `sandbox`       | 8788 (HTTP) | Hardened execution boundary; exec, files, preview and preview proxy.     |
| `egress-proxy`  | 8888 (HTTP) | The only route out of the sandbox network; enforces `EgressPolicy`.      |
| cloud (on host) | 8790        | Cloud API, dashboard and `/preview/<id>/` proxy (`apps/cloud`).          |

Both images build from the repository root so package sources keep their layout:

```bash
docker build -f infra/sandbox/Dockerfile -t freebuff/sandbox:local .
docker build -f infra/sandbox-proxy/Dockerfile -t freebuff/sandbox-proxy:local .
```

## Isolation model

Local containers are a development stand-in for the production boundary (see `DECISIONS.md` D7, D20).
Both paths use constraints encoded in the platform, not in a shell script:

- read-only root filesystem, tmpfs workspace, non-root user (`1000:1000`)
- `cap_drop: ALL`, `no-new-privileges`, PID / memory / CPU / file-descriptor limits
- TTL enforced by `packages/sandbox-orchestrator` (`SandboxManager.reapExpired`)
- `SandboxSpec.egress` (`deny_all` default) mapped to the internal proxy network or the microVM tap
  policy; the sandbox network is `internal: true`, so there is no default route at all

Inside the boundary the runtime applies a second layer that also holds in the development provider:
workspace path jail (including symlink escapes), `ulimit` caps, command timeouts, bounded output,
token-authenticated control API and a supervised preview process whose port is read from its own logs
and verified with an HTTP probe.

The **process provider** (`isolation: "process"`) has no kernel boundary and exists for local
development and tests only; the cloud API reports the isolation of every sandbox it lists.

## CI coverage

- `sandbox-image` builds the image, boots it with the compose isolation flags, and exercises
  `/exec`, `/files/*` and `/preview/*` through the control API.
- `sandbox-docker-provider` creates a sandbox with `DockerProvider` against the real Docker daemon.

## Not yet here

`firecracker/` host definitions (kernel, rootfs, tap setup), Windows/macOS signing material
(`signing/`) and Kubernetes manifests land with their phases (still 3 for Firecracker host assets, 5
for signing). The orchestrator-side Firecracker contract ships in
`packages/sandbox-orchestrator/src/firecracker.ts`.
