# @pwrdrvr/agent-client

## 0.3.0

### Minor Changes

- Resume ACP chat threads across process restarts. ACP sessions live in the agent
  process, so a host that persists threads (e.g. across an app relaunch) hit
  "Unknown ACP thread" on the next turn — the in-memory session was gone.

  - `AcpAgentClient.reopenThread({ threadId, buildInstructions? })` re-establishes
    a fresh ACP session BOUND to the existing host thread id (no-op when the
    session is already live). The system prompt is re-applied to the next turn;
    `buildInstructions` is a lazy callback so the host only rebuilds the prompt
    when a re-establish actually happens. The agent starts fresh (prior turns
    aren't replayed) but the host keeps the visible transcript.
  - `ChatThreadController.sendMessage` calls `reopenThread` (when the backend
    implements it) before each turn, so a persisted ACP thread transparently
    re-opens. No-op for backends that persist threads server-side (Codex).

  Verified live: a fresh client resumes a persisted Gemini thread and completes a
  turn.

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
