# @pwrdrvr/agent-client

## 0.6.0

### Minor Changes

- `ChatThreadController` `backendClientShared` opt-out. `onToolCall`/
  `onApprovalRequest` register a SINGLE handler on the backend client, so two
  controllers sharing one client (a pooled per-process ACP agent serving multiple
  surfaces) would clobber each other. Set `backendClientShared: true` to skip those
  registrations — the shared client owns the permission policy (e.g. auto-approve
  its trusted MCP tools, deny the agent's own tools, which the client does by
  cancelling when no host handler is registered). `onEvent` is multi-subscriber and
  is always wired.

## 0.5.0

### Minor Changes

- Agent lifecycle pool + per-thread MCP tools, so one shared ACP process can serve
  every surface.

  - **`AcpAgentClientPool`** (agent-acp): `acquire(key, factory)` returns the SAME
    warmed client for a key; concurrent acquires share ONE spawn (the in-flight
    promise), so a careless caller can't spin up dozens of agent processes. A
    failed/timed-out warm-up evicts + retries. `warm(key, factory)` is
    fire-and-forget for non-blocking startup; `release(key)` / `closeAll()` own
    teardown. New `AcpAgentClient.connect()` warms the process (spawn +
    `initialize`) without opening a session.
  - **Per-thread MCP servers**: `AcpAgentClient.reopenThread` accepts `mcpServers`,
    overriding the client-level default for THAT session, and
    `ChatThreadController` forwards a per-surface `threadMcpServers` dep to it. So a
    single shared agent process can host library-chat threads (library tools) and
    sizzle-chat threads (sizzle tools) at once — each thread spawns its own tools.

## 0.4.0

### Minor Changes

- Make "new chat" instant for ACP backends. Creating a chat thread eagerly called
  `startThread`, which for ACP spawns the agent process + opens a session (~3-5s) —
  so opening a new chat blocked for seconds before the user had even typed.

  - `AcpAgentClient.createDeferredThread` mints a thread id WITHOUT spawning the
    agent or opening a session. The session is established lazily on the first
    turn (via the existing `reopenThread` seam the controller already calls), so
    the multi-second spawn happens only when the user actually sends a message.
  - `ChatThreadController.createThread` uses `createDeferredThread` when the
    backend implements it; Codex (no such method) opens the thread eagerly as
    before.

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
