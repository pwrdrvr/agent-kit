---
"@pwrdrvr/agent-acp": minor
---

Support ACP v1 stdio, HTTP, and SSE MCP server configurations across session
new and load. Normalize env/header collections to the pinned protocol wire
shape, expose optional transport capability helpers, isolate per-thread MCP
configuration on pooled clients, and redact MCP credentials from lifecycle
errors.
