---
"@pwrdrvr/agent-acp": patch
---

ACP: drop unparseable `config_option_update` notifications instead of erroring

When the host sets a config option (e.g. Kimi thinking on/off), the agent echoes
a `session/update` with `sessionUpdate: "config_option_update"`. The underlying
ACP library's session-update schema has no such variant, so it rejected the
whole notification with `-32602` and logged "Error handling notification" on
every config change. The validated path can't deliver that update to any
consumer anyway, so the inbound sanitizer now drops it cleanly (no behavior
change beyond removing the error spam).
