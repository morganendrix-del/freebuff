# @freebuff/llm-providers

Status: **not started** — delivered by the Phase 1 gate.

Scope: provider shims for DeepSeek (free default), OpenAI and Anthropic behind one streaming
interface: request mapping, SSE parsing, tool-call normalisation, usage accounting, and the shared
HTTP client that applies timeout, retry and circuit-breaker policy to every call.

Model choice comes from `resolveModelForTier` in `packages/shared/src/config/models.ts`; no call
site names a model directly.
