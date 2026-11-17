# @freebuff/db

Status: **not started** — delivered by the Phase 4 gate.

Scope: the app-builder data plane (Convex schema, queries, mutations, migration engine) and the
platform metadata store in Postgres (users, projects, sessions, quota windows, ad impressions,
deployments). Generated apps get real schema and real migrations — never an in-memory stand-in.

Gate: one prompt produces a deployed app whose data survives reload and is scoped per user.
