---
"@pwrdrvr/agent-acp": patch
---

Decode outer shell escapes when a POSIX script word joins quoted fragments,
and preserve the full invocation when it uses Bash ANSI-C or locale quoting.
