---
"@pwrdrvr/agent-transport": patch
---

Disconnect and terminate the owned child when a stdio pipe fails. Reject pending JSON-RPC requests promptly, including requests waiting on an outbound observer, and discard late replies to child-originated requests after disconnect or reconnect.
