# @freebuff/cloud

Status: **implemented** (Phase 3).

Sandbox dashboard, import API and preview manager. Imports a repository (public URL or GitHub App
installation token), runs it in an isolated sandbox and serves the preview.

## Run

```bash
# development: process provider, no Docker needed
SANDBOX_PROVIDER=process CLOUD_API_TOKEN=dev-token bun run cloud
# → http://127.0.0.1:8790 (dashboard + API)

# containers: hardened sandbox image (see infra/README.md)
docker build -f infra/sandbox/Dockerfile -t freebuff/sandbox:local .
SANDBOX_PROVIDER=docker CLOUD_API_TOKEN=dev-token bun run cloud
```

`CLOUD_PUBLIC_URL` sets the origin used in returned preview links (put it behind your TLS terminator);
without it the bound address is used.

## API

| Route                          | Behaviour                                                                               |
| ------------------------------ | --------------------------------------------------------------------------------------- |
| `GET /`                        | Dashboard: import form, live status, preview links, stop buttons                        |
| `POST /v1/sandboxes`           | `{repo:"owner/name" \| owner,name, branch?, cloneUrl?, previewCommand?}` → `202` record |
| `GET /v1/sandboxes`            | All sandboxes with status, stages, failure and preview URL                              |
| `GET /v1/sandboxes/:id`        | One sandbox                                                                             |
| `GET /v1/sandboxes/:id/events` | SSE stream of status and pipeline events                                                |
| `POST /v1/sandboxes/:id/stop`  | Stop and free the sandbox                                                               |
| `GET\|HEAD /preview/:id/*`     | Proxy to the sandbox dev server (public shareable preview)                              |
| `GET /health`                  | Liveness                                                                                |

Management routes require `Authorization: Bearer $CLOUD_API_TOKEN` when the variable is set; preview
links are public by design but keyed by an unguessable sandbox id and cannot reach the control API.

## Guarantees and limits

- Sandbox isolation is reported per record (`process`, `container`, `microvm`) and never implied.
- Pipeline failures name the stage: `clone_failed`, `install_failed`, `preview_failed`,
  `provision_failed`.
- Sandboxes are stopped at their TTL by a background reaper.
- Accounts, per-user ownership and GitHub OAuth sign-in arrive with the web builder in Phase 4; the
  API token is per-deployment until then.
