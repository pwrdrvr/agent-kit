---
"@pwrdrvr/agent-transport": patch
---

Frame JSON-RPC stdio on LF only, preserving literal Unicode separators and split UTF-8 characters. Accept CRLF and final EOF tails. Export readJsonRpcLines for callers that own their processes and stderr handling. Report malformed inbound messages with content-free diagnostics.
