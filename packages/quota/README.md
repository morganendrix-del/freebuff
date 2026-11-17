# @freebuff/quota

Status: **not started** — window/tracker in Phase 2, country policy and phone verification in Phase 5.

Scope: server-authoritative hour accounting. Starting an hour consumes one hour-credit, unlimited
messages are allowed inside it, windows expire at the earlier of one hour and local midnight, no
rollover. Country allowances come from `packages/shared/src/config/countries.ts`.

Gate: free tier fully usable under quota; a client that lies about its usage still gets denied.
