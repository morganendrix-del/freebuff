# @freebuff/cli

Status: **not started** — delivered by the Phase 2 gate.

Stack: TypeScript + OpenTUI + React renderer, Commander.js argument parsing, TanStack Query for
server state. Includes auth gating, project picker, persistent chat history, the sponsored slot and
the quota bar.

Terminal command broker: spawns shells in the sandbox over a dedicated channel so agent stdio is
never corrupted by child-process output.

Gate: end-to-end demo — auth → project picker → multi-file edit → terminal command → chat persistence.
