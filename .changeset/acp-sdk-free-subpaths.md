---
"@pwrdrvr/agent-acp": minor
---

Add SDK-free subpath exports: `@pwrdrvr/agent-acp/strategies`, `@pwrdrvr/agent-acp/discovery` and `@pwrdrvr/agent-acp/mcp-server-config`. A host can read the strategy table, run local discovery and normalize MCP server configs without loading `@agentclientprotocol/sdk`, which the root entry imports at top level. The root entry is unchanged.
