# @pwrdrvr/agent-client

## 0.8.0

### Minor Changes

- e7678de: Report a probe that ran out of time as "did not answer in time" instead of "not installed", and let callers own the budget.

  `codex-discovery`: the `<command> --version` probe no longer hardcodes 2s. `DEFAULT_COMMAND_VERSION_TIMEOUT_MS` (10s) is exported and overridable per call via `versionTimeoutMs` on `DiscoverCommandOptions`, `discoverCodexCommands`, and `resolveCodexCommand`; 2s sat on top of a warm npm `codex.cmd` (~1.5s for its `cmd.exe → node → shim` chain), so a loaded machine crossed it. The now-exported `readCommandVersion` returns a `CommandVersionProbeOutcome` (`ok`, `version_not_reported`, `not_found`, `not_executable`, `timed_out`, `aborted`, `failed`), and that outcome rides on every discovery candidate and on `ResolvedCommandCandidate`, so a consumer gating on version can tell an unfinished measurement from a missing CLI and re-probe on its own budget (`isUnprovenVersionProbe` names that set). A timed-out candidate is no longer labelled `not_executable`, and is no longer filtered out of the snapshot. `CodexCliNotInstalledError` carries `timedOutCommands` / `probeTimedOut` when a timeout — not a missing binary — is why nothing resolved. All entry points accept an `AbortSignal`; an aborted run yields a snapshot with `error: COMMAND_DISCOVERY_ABORTED` (and `CodexDiscoveryAbortedError` from `resolveCodexCommand`) rather than a false "not installed". `collectCodexStatus` / `checkCodexAuthStatus` gain a budget (`DEFAULT_CODEX_STATUS_TIMEOUT_MS`, 10s) where they previously had none at all and could hang forever, and both report a `CodexStatusOutcome` (`answered` / `timed_out` / `aborted` / `spawn_failed`) so a slow — or caller-cancelled — check is not read as a signed-out profile.

  `agent-acp`: local discovery keeps a candidate whose probe ran out of budget visible as `reason: "probe-timed-out"` even on the default path, rather than dropping its whole group and reporting the agent as not installed. `AcpConnection.request` now enforces the `timeoutMs` it has always accepted and silently ignored — an agent that took a request and went quiet hung the caller indefinitely, including the 30s `initialize` and 1h `session/prompt` budgets `AcpAgentClient` passes. Local discovery's probe budget is configurable via `probeTimeoutMs` (`DEFAULT_ACP_PROBE_TIMEOUT_MS`, unchanged at 5s) with `AbortSignal` support, and a probe that overran is reported as `reason: "probe-timed-out"` rather than `version-probe-failed`.

  `agent-client`: `CodexThreadClient` and `CodexOneShotClient` resolve their binary through discovery on first connect, so they gain `commandVersionTimeoutMs` to size that probe. Without it a host could only take the default, and an overrun surfaced as `CodexCliNotInstalledError` from the first call.

  All three packages' probes now settle within their budget even when the child cannot be killed — on Windows a `.cmd` shim runs under `cmd.exe`, and killing the wrapper can leave a `node` grandchild holding the stdio pipes open, so waiting on process exit could hang past any timeout.

### Patch Changes

- Updated dependencies [e7678de]
  - @pwrdrvr/codex-discovery@0.2.0

## 0.7.0

### Minor Changes

- 2831451: Update `@pwrdrvr/codex-app-server-protocol` to 0.144.0 and emit its new
  discriminated dynamic-tool wire format. Add `toDynamicToolFunctionSpec` for flat
  function consumers, support unnamespaced and deferred tools, and make
  `buildToolCatalog` group namespaced tools into namespace objects. Unnamespaced
  tools cannot be deferred, and tool calls are routed by both namespace and name.

## 0.6.2

### Patch Changes

- 19423da: Update @pwrdrvr/codex-app-server-protocol to 0.135.0.

## 0.6.1

### Patch Changes

- Updated dependencies
  - @pwrdrvr/agent-core@0.2.0
  - @pwrdrvr/agent-transport@0.1.6
  - @pwrdrvr/codex-discovery@0.1.3

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
