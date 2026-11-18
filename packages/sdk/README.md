# @freebuff/sdk

Status: **implemented** (Phase 2). Gate: the CLI talks to the platform only through this package.

The typed platform client every surface uses. No module outside this package issues platform HTTP
requests, and the CLI imports nothing else for auth, projects, sessions, quota, ads or terminals.

## Surface

```ts
const client = createPlatformClient({ baseUrl, token });
await client.auth.login(email); // { token, user, isNewUser }
await client.projects.list(); // ProjectRef[]
await client.sessions.create({ projectId, surface, title });
await client.sessions.appendMessages(id, messages);
await client.quota.authorizeRun(); // QuotaDecision (server-authoritative)
await client.ads.select({ surface: "cli", contextTags: ["code"] }); // AdSelection | null
await client.terminals.exec(terminalId, "bun test");
```

| Module      | Responsibility                                                               |
| ----------- | ---------------------------------------------------------------------------- |
| `client.ts` | `PlatformClient`: auth, projects, sessions, quota, ads, terminals            |
| `http.ts`   | JSON transport: envelope handling, request ids, bearer token, timeout, retry |
| `errors.ts` | `SdkError` with `apiCode`, `status`, `requestId`; status → code mapping      |
| `types.ts`  | DTOs and the `PlatformClient` interface (fakeable in tests)                  |

## Transport rules

- Responses are envelopes: `{ ok: true, data }` or `{ ok: false, error }`. Anything else is an
  `internal` error rather than an accidental success.
- `GET` requests retry 408/429/5xx with the shared jittered backoff; mutations never retry, because a
  duplicated append is worse than a visible failure.
- Every call has a timeout (`withTimeout`, 20 s default) and a generated request id sent as
  `x-request-id`; the server's id is preserved on the error.
- Agent run streaming over the platform API lands with the hosted service in Phase 3; in Phase 2 the CLI
  runs the agent in-process and uses this client for everything else.

## Tests

`tests/unit/sdk-http.test.ts` — bearer header and request id, envelope unwrapping, 401 without retry,
429 retry on GET, no retry on mutation, malformed body, timeout.
