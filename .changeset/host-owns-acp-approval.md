---
"@pwrdrvr/agent-acp": minor
---

Remove the client's `autoApproveConfiguredMcpTools` option (and its server-name
matcher). The ACP client no longer makes any trust decision of its own — every
`session/request_permission` is forwarded to the host's `onApprovalRequest`
handler, now enriched with the context the raw ACP params lack: the resolved
`threadId` and `mcpServerNames` (the union of the client's default servers and
every live session's per-thread servers). The host owns the policy and can
recognize a tool call that targets a server IT configured.

This fixes the fragility where the kit guessed which permission requests were
host MCP tools via a Gemini-shaped string heuristic that broke for other CLIs
(Kimi, Grok). Hosts now match against their OWN known servers/tools, which is
both more precise and the correct layer for a trust decision.

BREAKING: consumers relying on `autoApproveConfiguredMcpTools` must instead
register an `onApprovalRequest` handler and approve based on the new
`params.mcpServerNames`. An `"approved"` decision now prefers the broadest
allow option (session-wide server allow) so a host pre-approving its own tools
isn't re-prompted every call.
