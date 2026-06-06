---
"@pwrdrvr/agent-core": patch
"@pwrdrvr/agent-acp": patch
---

Stop a titleless tool-call update from clobbering the real tool name, and log
raw tool notifications for diagnosis.

- agent-core: add the humanized `tool_call_update` fallback ("tool call update"
  / "tool_call_update") to GENERIC_LABELS, so `preferSpecificLabel` no longer
  lets a titleless update overwrite the specific tool name from the initial
  `tool_call`. Agents like Grok stream `tool_call_update` notifications with no
  `title`/`name`, which previously made activity chips read "tool call update"
  instead of the tool name.
- agent-acp: `AcpConnection`/client now debug-logs each inbound tool
  notification ("acp tool notification" — kind, toolCallId, title, name,
  status), so a host can see exactly how many distinct tool-call ids an agent
  streamed and whether each carries a name (the chips dedup by id; the kit
  emits one tool_call per new id and merges updates).
