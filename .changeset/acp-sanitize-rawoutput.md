---
"@pwrdrvr/agent-acp": patch
---

Sanitize inbound ACP notifications so a non-spec `rawInput`/`rawOutput` doesn't
get the whole `session/update` rejected. The official ACP library (adopted in
0.9.0) validates inbound notifications and types tool_call(_update)
`rawInput`/`rawOutput` as `z.record` (a plain object). Real agents don't honor
that — Kimi sends `rawOutput` as a JSON STRING (a tool's text result) or an
ARRAY — so validation failed with `-32602 Invalid params`, the library logged
"Error handling notification", and the tool's status update was silently
dropped (our old hand-rolled connection never validated, so it tolerated this).
`AcpConnection` now wraps the agent's stdout and coerces a non-object
`rawInput`/`rawOutput` to `{ value: <orig> }` (data preserved, schema
satisfied), dropping an explicit `null`, before the library frames + validates
the line. Plain-object values pass through untouched.
