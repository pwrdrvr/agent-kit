---
"@pwrdrvr/agent-acp": minor
---

Implement `AcpAgentClient.archiveThread(threadId)`. ACP has no protocol-level
session delete/archive (sessions are connection-scoped; the spec offers only
`session/cancel`), so unlike the Codex backend there's no remote call to make —
but the client now releases the session LOCALLY on archive: it best-effort
cancels an in-flight turn, then drops the `AcpSessionState` + protocol-id
mapping. Previously archiveThread was unimplemented, so a long-lived pooled
client (one process shared across surfaces) accumulated a dead session for every
closed chat until the whole client was closed. Idempotent; a later
`reopenThread` re-establishes a fresh session under the same threadId.
