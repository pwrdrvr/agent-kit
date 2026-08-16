---
"@pwrdrvr/agent-client": minor
---

Codex process owner + per-surface backend views + pool

Adds `CodexProcessOwner` — one owned `codex app-server` process/connection that
hands out lightweight per-surface `CodexBackendView`s (each an `AgentBackend`),
so many chat surfaces share ONE Codex process. Every inbound notification and
every tool-call/approval server-request is demultiplexed by `threadId` to the
view that owns that thread, so sibling surfaces never clobber each other's
handlers (plain `CodexThreadClient` exposes a single global handler slot — that
clobber is exactly what this fixes). The owner also exposes `listModels()` and a
structured `runOneShot()` (outputSchema, local images, per-turn rollback, token
usage, abort) over the SAME connection, so model-picker refreshes and capture
enrichment no longer each spawn their own App Server.

`CodexProcessOwnerPool` mirrors `AcpAgentClientPool` (`acquire`/`warm`/`has`/
`release`/`closeAll`), keyed by the host on connection identity (command,
`CODEX_HOME`/env), giving one process per key with deduped concurrent warm-ups
and app-level shutdown.

`CodexThreadClient` and `CodexOneShotClient` are now thin shims over the owner
(a single default view, and `runOneShot`/`listModels` respectively). Their public
APIs and behavior are unchanged — additive release.
