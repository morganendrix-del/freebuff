# fixtures

Fixture repositories for the Phase 1 agent harness. Each fixture is a minimal repo plus a scripted
task list (prompt, starting state, expected file diffs). The harness replays recorded provider
responses so gate runs are deterministic and offline.

Gate: 5/5 scripted tasks produce exactly the expected diffs.
