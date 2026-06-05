# @pwrdrvr/agent-acp

## 0.5.0

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

## 0.4.0

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

## 0.3.1

### Patch Changes

- Detect Kimi by the `acp --help` exit code, not its help-text prose (mirrors
  PwrAgent #645). kimi's commander CLI exits non-zero for an unknown subcommand,
  so a zero-exit `kimi acp --help` already proves the `acp` subcommand exists —
  and the kit's discovery already rejects a failed help probe. Parsing the help
  wording was fragile: it has drifted across kimi versions (0.11.0 prints "Agent
  Client Protocol (ACP) server over stdio"). `helpMatches` is now optional on a
  strategy; the kimi strategy omits it and relies on the exit code. Gemini / Grok
  / Qwen keep their regexes (they probe the general `--help`, which always exits
  zero, so they still need the text to confirm `--acp` support).

## 0.3.0

### Minor Changes

- Auto-approve host-configured MCP tools, fix approval routing, and prefer the
  agent's session GUID for thread ids.

  - **`autoApproveConfiguredMcpTools` option**: when set, `session/request_permission`
    for a tool served by one of the configured `mcpServers` is approved
    automatically (preferring a session-wide server allow so the agent stops
    prompting) WITHOUT a host round-trip. Those servers are host-trusted, so the
    agent shouldn't prompt to call them. The agent's OWN tools (shell/file/web)
    still route to the host approval handler. Verified live: Gemini calls a host
    MCP tool with no approval prompt.
  - **Approval routing fix**: ACP permission requests only carry a `sessionId`,
    not the kit `threadId`. The client now injects the RESOLVED `threadId` into
    the params it passes to the host approval handler, so hosts can match the
    approval to a thread even with multiple turns in flight (previously they were
    forced to auto-deny).
  - **Thread id from session GUID**: `threadId` now reuses the agent's session id
    when it's a well-formed UUID (`acp:<strategy>:<sessionId>`), falling back to a
    host-minted `randomUUID()` otherwise — traceable to the live session, still
    globally unique, never a counter.

## 0.2.3

### Patch Changes

- Use a host-minted UUID for the ACP thread id (`acp:<strategy>:<uuid>`) instead
  of the `<instance>-<seq>` scheme from the previous patch. ACP returns a session
  GUID (`sessionId`), which the client keeps as the wire-routing id; the
  host-facing `threadId` is now `randomUUID()` — globally unique regardless of how
  (or whether) a given agent makes its session id unique, and no integer counter.

## 0.2.2

### Patch Changes

- Mint globally-unique ACP thread ids. The id was `acp:<strategy>:<n>` where `n`
  is a per-client-instance counter starting at 1, so the first thread was
  `acp:gemini:1` on every client instance AND every process restart. Hosts that
  persist threads under a UNIQUE thread id (PwrSnap's `chat_threads.thread_id`)
  hit a constraint violation on the second run ("Chat is unavailable"). Ids are
  now `acp:<strategy>:<instance>-<seq>` with a per-client random instance base —
  globally unique, still monotonic + distinct within a client. The `acp:<id>:`
  prefix is unchanged.

## 0.2.1

### Patch Changes

- Fix `session/new` MCP server serialization. `mcpServers` were sent with `env`
  as a `Record` and `args` omitted, but ACP's `McpServer` wire shape requires
  `args: string[]` and `env: Array<{ name, value }>`. Strict agents (Gemini)
  rejected the record with an opaque "-32603 Internal error" on `session/new`,
  breaking any MCP tool bridge. The ergonomic `AcpMcpServerConfig` (`env` as a
  `Record`, optional `args`) is unchanged — translation happens at the protocol
  boundary. Verified live: Gemini now spawns the host MCP server and calls a tool.

## 0.2.0

### Minor Changes

- ACP turns now resolve at turn START, not turn end, and chat agents receive the
  host system prompt.

  - **Non-blocking `startTurn`**: `AcpAgentClient.startTurn`/`startTurnNative` now
    return as soon as the turn is registered (after `turn_started`) and stream the
    terminal events (`token_usage`, `agent_message`, `turn_completed`/`error`)
    asynchronously when `session/prompt` settles. Previously `startTurn` awaited
    the whole turn, so any host gating UI on it (a chat composer) froze for the
    entire turn — and a slow/large session `cwd` read as a hang. Now matches the
    Codex backend's fire-then-stream contract. Turn failures arrive as
    `turn_completed{status:"failed"}` + `error` events instead of a `startTurn`
    rejection. `AcpOneShotClient.run` updated to await `turn_completed`; `close()`
    awaits any in-flight turn so teardown never orphans one.
  - **System prompt for ACP chat**: `startThread({ instructions })` is no longer
    dropped — ACP has no `session/new` baseInstructions seam, so the instructions
    are folded into the FIRST turn's prompt as a leading text block (consumed
    once). ACP chat agents previously ran with no host system prompt / persona /
    anchor context.

## 0.1.9

### Patch Changes

- Discover Kimi Code CLI when it isn't on PATH. Two fixes to the `kimi` strategy:

  - Add fallback install paths (`~/.kimi-code/bin/kimi`, Homebrew, `/usr/local`),
    mirroring grok/qwen. The official installer drops a standalone binary at
    `~/.kimi-code/bin/kimi` and does NOT add it to PATH, so a GUI-launched app
    missed it entirely.
  - Fix the help-match regex. Real `kimi acp --help` (v0.11.0) says "Agent Client
    Protocol (ACP) server over stdio"; the old `/\bACP server\b/` never matched
    because of the `)` between "ACP" and "server", so the probe rejected even an
    on-PATH Kimi.

  Verified end-to-end against a real Kimi Code 0.11.0 install.

## 0.1.8

### Patch Changes

- Report ACP token usage. Agents return per-turn usage on the `session/prompt`
  RESPONSE (`_meta.quota.token_count`, e.g. Gemini's input/output tokens), which
  the client previously discarded. `AcpAgentClient` now parses it and emits a
  `token_usage` event, so `AcpOneShotClient.run()` returns `tokenUsage` and hosts
  can account for ACP turns like Codex turns. Verified live against Gemini.

## 0.1.7

### Patch Changes

- Ensure the ACP session working directory exists before `session/new`. Agents use
  `cwd` as their workspace; some (Gemini) fail `session/new` with an opaque
  "-32603 Internal error" when it doesn't exist. `AcpAgentClient` now best-effort
  `mkdir -p`s the cwd first, so a host passing a not-yet-created workspace dir
  (e.g. a per-job scratch dir) works instead of failing cryptically.

## 0.1.6

### Patch Changes

- Add `AcpOneShotClient.listModels()` — opens a throwaway session and returns the
  agent's advertised models (ACP agents report runtime models/modes on
  `session/new`). Lets a host populate a model picker with the agent's real models
  (e.g. Gemini's `gemini-2.5-pro`, `gemini-3-flash-preview`) instead of guessing.

## 0.1.5

### Patch Changes

- Add `AcpOneShotClient` — a non-interactive single-turn driver over an ACP agent
  (the ACP analog of `CodexOneShotClient`), for jobs like capture enrichment.
  Keeps the agent process persistent and opens a FRESH session per `run()` (the
  ACP equivalent of Codex's per-turn rollback), auto-denies approvals, and
  rejects tool calls so the agent can only answer. ACP has no `outputSchema`, so
  the caller bakes the "reply with JSON only" contract into the prompt and parses
  the returned text. Verified live: Gemini-in-ACP took an image and returned
  clean JSON.

## 0.1.4

### Patch Changes

- Discover and run agent CLIs installed by a node/JS version manager. Discovery
  now scans well-known bin dirs (every `~/.nvm/versions/node/*/bin`, plus volta /
  bun / asdf / deno / `~/.local/bin` / Homebrew) in addition to `PATH`, so an
  `npm i -g qwen` under nvm is found even though a GUI app's minimal `PATH`
  doesn't list it (`wellKnownAgentBinDirs`). And `prependCommandDirToPath`
  (agent-transport) prepends an absolute command's own directory to `PATH` for
  both the discovery probe and the agent spawn, so a Node-script CLI
  (`#!/usr/bin/env node`) finds its sibling `node` — without it, probing/spawning
  an nvm-installed CLI fails with `env: node: No such file or directory`.
- Updated dependencies
  - @pwrdrvr/agent-transport@0.1.4

## 0.1.3

### Patch Changes

- Multi-instance ACP agent discovery. `discoverLocalAcpAgentInstances` returns
  EVERY installed executable of each agent — every `PATH` match plus the
  strategy's fallback paths plus an optional override that passes the probe —
  each with its parsed version and where it was found (`override` / `path` /
  `fallback`). The default `PATH` scan is injectable (`listExecutables`) and the
  probe env is configurable (`env`), so a host can pass a hydrated `PATH`.
  `discoverLocalAcpAgents` is unchanged in shape (first match per agent), now
  implemented on top of the instance view.
