# @pwrdrvr/agent-client

## 0.2.0

### Minor Changes

- Surface ACP tool usage in chat. `ChatThreadController` previously broadcast tool
  activity only from the `onToolCall` request seam (Codex host tools). ACP agents
  run their own tools — directly or via an MCP server — and report them as streamed
  `tool_call` / `tool_call_update` events, which were ignored, so an ACP agent's
  tool calls showed no activity chips. The controller now accumulates streamed tool
  calls and broadcasts each once it reaches a terminal status (the host UI dedups
  chips by id), giving ACP agents the same chips as Codex. Verified live: a Gemini
  MCP tool call surfaces a completed chip.
