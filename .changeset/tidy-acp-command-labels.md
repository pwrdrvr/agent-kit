---
"@pwrdrvr/agent-acp": patch
---

Use Antigravity's `run_command` summary for the activity label. When a shell
command supplies only a generic title or repeats the command as its title,
show a one-line label of at most 72 characters and keep the full command in
the activity details.
