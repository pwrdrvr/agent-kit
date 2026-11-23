---
"@pwrdrvr/agent-transport": patch
---

Disconnect the owned child when a stdio pipe fails and escalate termination if it stays alive. Reject pending JSON-RPC requests promptly, including requests waiting on an outbound observer. Deliver already-read notifications after exit and discard late replies to child-originated requests after disconnect or reconnect.
