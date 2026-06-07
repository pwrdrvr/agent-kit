# @pwrdrvr/agent-core

## 0.2.0

### Minor Changes

- Fix #1: preserve tool-call file locations and stop fabricating a command detail
  for read/file tools.

  - agent-core: `NormalizedToolCall` gains `locations?: NormalizedToolLocation[]`
    (`{ path, line? }`), and `mergeToolCall` carries it (a later non-empty update
    replaces; an omitting update keeps the prior list).
  - agent-acp: the ACP normalizer now populates `locations` from the ACP
    `locations` field (all entries, not just the first), and builds a `command`
    detail ONLY for genuine command tools (a command string or exit code present).
    A `read`'s file content stays on `result` and its path rides `locations`,
    instead of being folded into a fake `command.displayCommand` (the data loss
    PwrAgent's lossless-replay parity harness flagged).

## 0.1.3

### Patch Changes

- a3ce7cb: Stop a titleless tool-call update from clobbering the real tool name, and log
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
