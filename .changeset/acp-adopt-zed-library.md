---
"@pwrdrvr/agent-acp": minor
---

Adopt the official `@zed-industries/agent-client-protocol` library for the ACP
wire layer. The hand-rolled ACP message types + JSON-RPC client calls are
replaced by the library's `ClientSideConnection` + `ndJsonStream` (spec-tracked
types, schema validation, maintained upstream). We keep what the library
doesn't do: discovery, process spawn/lifetime, the normalizer (ACP → neutral
events), and per-agent quirks.

BREAKING: `AcpStdioJsonRpcTransport` (+ `AcpStdioJsonRpcTransportOptions`) is
removed. Construct `AcpConnection` instead — same options (`command` / `args` /
`env` / `logger`) and the same `AcpJsonRpcTransport` interface, so
`AcpAgentClient` / `AcpOneShotClient` / pool are unchanged. Non-standard methods
(`session/set_config_option`) and vendor notifications (Grok's
`session_summary_generated`) ride the library's `extMethod` / `extNotification`.

Verified live end-to-end against grok 0.2.22 and kimi 0.11.0 (session +
streamed assistant reply through the new path).
