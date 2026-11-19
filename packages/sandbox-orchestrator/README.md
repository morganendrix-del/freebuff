# @freebuff/sandbox-orchestrator

Status: **implemented** (Phase 3).

Turns a repository into a running, isolated sandbox with a reachable preview, and hosts the control
API the agent's `run_command` and file tools travel through.

## Layers

| Module                                 | Responsibility                                                                                           |
| -------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `src/lifecycle.ts`                     | Pipeline: provision → clone → detect stack → install → launch → probe; stage timings, TTL, failure codes |
| `src/provider.ts`                      | `SandboxProvider` / `SandboxInstance` contract shared by all isolation backends                          |
| `src/docker.ts`                        | Hardened container backend (read-only rootfs, cap drop, no-new-privileges, cgroup limits, internal net)  |
| `src/firecracker.ts`                   | microVM backend: VM config, API calls, read-only rootfs + workspace drive, tap networking                |
| `src/process.ts`                       | Development backend (`isolation: "process"`, no kernel boundary) used by tests and `bun run cloud`       |
| `src/runtime/`                         | The sandbox runtime itself: exec, files, preview, preview proxy, token auth                              |
| `src/workspace.ts`                     | Path jail: relative-only paths, lexical containment, symlink realpath checks, file caps                  |
| `src/exec.ts`                          | Command runner: scrubbed env, `ulimit` caps, process-group kill, timeout, bounded output                 |
| `src/preview.ts` / `detect-preview.ts` | Dev-server supervision: port read from logs, HTTP probe, log ring buffer, stop                           |
| `src/import.ts`                        | `git clone` of a `RepoSource`; token through `GIT_CONFIG_*`, never argv or the URL                       |
| `src/stack.ts`                         | Stack + package manager + install/dev command detection                                                  |
| `src/egress.ts`                        | `EgressPolicy` decisions and proxy environment                                                           |
| `src/runtime-client.ts`                | HTTP client for runtimes behind a port (Docker container, microVM guest)                                 |

## Runtime API

`createSandboxRuntime({ workspace, token, limits })` serves:

- `POST /exec` `{command, cwd?, timeoutMs?, env?}`
- `POST /files/{read,write,list,exists}`
- `POST /preview/start`, `GET /preview`, `POST /preview/stop`, `* /preview/proxy/*`
- `GET /health`, `GET /info`, `POST /shutdown`

Every route except `/health` requires `Authorization: Bearer <runtime token>` when a token is
configured. The runtime depends on `node:` builtins only, so it runs unchanged inside the image.

## Usage

```ts
const manager = new SandboxManager({
  provider: new DockerProvider({ image: "freebuff/sandbox:local" }),
  previewUrlFor: (id) => `https://cloud.example.com/preview/${id}/`,
});

const sandbox = await manager.create({ repo: { provider: "github", owner: "acme", name: "app" } });
sandbox.status; // "ready"
sandbox.previewUrl; // proxied preview
await manager.stop(sandbox.id);
```

## Gate (Phase 3)

Repository → reachable preview in under 120 s, with network, filesystem and resource isolation proven
by tests (`tests/integration/sandbox/*`, `src/*.test.ts`). Docker container isolation also runs against
a real daemon in CI (`sandbox-docker-provider`).
