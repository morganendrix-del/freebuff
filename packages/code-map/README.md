# @freebuff/code-map

Status: **not started** — delivered by the Phase 1 gate.

Scope: incremental repository indexer producing a symbol graph (files, exports, imports, definitions,
references) via tree-sitter/ripgrep, plus query helpers the agent exposes as `code_map_query`:
symbol lookup, callers, references, module outline.

Gate: index a fixture repo and answer symbol/reference queries with deterministic output.
