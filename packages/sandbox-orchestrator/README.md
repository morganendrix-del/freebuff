# @freebuff/sandbox-orchestrator

Status: **not started** — delivered by the Phase 3 gate.

Scope: lifecycle for isolated workspaces behind one interface — Docker locally, Firecracker microVMs
in production. Clones repositories, detects the stack, installs dependencies, launches the preview
server, enforces `ResourceLimits`/`EgressPolicy`/`readOnlyRootFilesystem`, and tears everything down
at TTL. Also hosts the shell broker the agent's `run_command` tool calls.

Gate: connect a public GitHub repo → reachable preview URL in under 120 s, with network, filesystem
and CPU/memory isolation proven by tests.
