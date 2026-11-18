# @freebuff/code-map

Status: **implemented** (Phase 1).

Repository symbol index plus the query surface the agent exposes as `code_map_query`. The indexer is a
fast, language-agnostic regex extractor today (JavaScript/TypeScript, Python, Go, Rust, SQL and friends)
with a deliberately small surface: files, exported definitions, and identifier references. The
`CodeMap` shape is what a tree-sitter backend would produce, so it can be swapped in without touching
callers (`DECISIONS.md` D15).

## Surface

| Export                        | Purpose                                             |
| ----------------------------- | --------------------------------------------------- |
| `indexRepository(root)`       | Builds a `CodeMap` (files, symbols, references)     |
| `createCodeMapService(map)`   | Read-only `query` service used by the tool layer    |
| `queryCodeMap(map, query)`    | `files`, `outline`, `symbols`, `references` queries |
| `formatCodeMapResult(result)` | Compact text rendering for model consumption        |

Symbols carry `name`, `kind` (`function`/`class`/`const`/`type`/`interface`/`export`), `file`, `line`
and `exported`. Queries are capped (500 symbols, 200 references) and set `truncated` rather than
returning unbounded output.

## Tests

`packages/code-map/test/indexer.test.ts` — indexes a fixture repo and asserts symbol lookup, module
outlines, reference lookup and truncation flags.
