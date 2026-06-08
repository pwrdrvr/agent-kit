# @pwrdrvr/agent-acp

## 0.12.0

### Minor Changes

- 59b67ba: ACP: support agents that expose model + thinking as `configOptions` (Kimi)

  Kimi Code CLI advertises its model and reasoning controls as ACP `configOptions`
  (`category: "model"` / `category: "thought_level"`) rather than the top-level
  `models` / `modes` other agents use. Two consequences are fixed:

  - **Model reporting.** `AcpAgentClient.startThread()` and the one-shot
    `listModels()` now read the effective model from the `model` configOption when
    no `models.currentModelId` is advertised, so hosts see a real model id +
    label (`kimi-code/kimi-for-coding` / "Kimi-k2.6") instead of an empty
    "model unavailable". New exported helpers: `modelIdFromCapabilities`,
    `modelsFromCapabilities`, `modelConfigOption`.

  - **Reasoning effort.** `applyReasoning` now falls back to a `thought_level`
    (or id `thinking`) configOption when no ACP mode matches: low-effort tokens
    map to its OFF value, high-effort to its ON value, via
    `session/set_config_option`. This lets a one-shot enrichment turn (`effort:
"low"`) disable a reasoning model's thinking pass — dramatically faster for
    structured one-shot jobs. New exported helper `reasoningValueForThoughtLevel`.

  Additive and backward-compatible: agents that advertise `models`/`modes`
  (Gemini, Grok, Qwen) are unaffected; the new behavior only engages when the
  corresponding configOption is present and the existing path finds no match.

## 0.11.0

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

### Patch Changes

- Updated dependencies
  - @pwrdrvr/agent-core@0.2.0
  - @pwrdrvr/agent-transport@0.1.6

## 0.10.3

### Patch Changes

- Serialize JSON-RPC error objects into readable messages. `errorMessage` (used
  for turn errors and the "model selection not applied" log) did `String(error)`,
  which renders a plain JSON-RPC error object (`{ code, message, data }`) as the
  useless `[object Object]`. It now extracts the error's `message` (+ `code`),
  falls back to a JSON dump, and never returns `[object Object]` or a literal
  `"undefined"`. This surfaces _why_ an agent rejected a request — e.g. why Grok
  refuses `session/set_model` for an advertised model.

## 0.10.2

### Patch Changes

- Report the model that actually ran from `AcpOneShotClient`, not the requested
  one. `startThread` swallowed whether `setModel` applied, so a one-shot response
  echoed the requested model id even when the agent rejected it (e.g. a stale
  cross-provider id Grok ignores). It now tracks the `setModel` outcome and
  returns the effective model — the requested id only when applied, otherwise the
  agent's own session default (or `""` when none is advertised). Fixes a host
  pricing/usage UI showing a rejected model id for the run.

## 0.10.1

### Patch Changes

- Recognize Grok/xAI token usage. Grok reports counts as camelCase fields directly
  on the `session/prompt` response `_meta`
  (`_meta.{totalTokens,inputTokens,outputTokens,cachedReadTokens,reasoningTokens}`),
  not under `_meta.usage`/`_meta.quota`. `readAcpPromptUsage` now accepts camelCase
  aliases in the generic usage parser and tries `_meta` itself as a usage source,
  so Grok runs report token usage (and downstream list-price) instead of "usage
  unavailable".

## 0.10.0

### Minor Changes

- Surface the agent's default model. `AcpRuntimeModel` gains an optional
  `isDefault` flag, set on the model whose id matches the agent's protocol-reported
  `currentModelId`. It flows everywhere runtime model capabilities are read,
  including `AcpOneShotClient.listModels()` — so a host can pre-select the true
  agent default and label it "(default)" instead of guessing first-in-list.
  Additive/non-breaking; absent when an agent advertises models but no current id.

## 0.9.3

### Patch Changes

- Broaden ACP token-usage parsing beyond Gemini's quota shape. `readAcpPromptUsage`
  now also recognizes the OpenAI dialect (`usage.{prompt_tokens,completion_tokens,
prompt_tokens_details.cached_tokens,completion_tokens_details.reasoning_tokens}`,
  used by Grok/xAI and Qwen) and the Anthropic dialect (`usage.{input_tokens,
output_tokens,cache_read_input_tokens}`), at either the result root or under
  `_meta`. When no recognized shape is present, a debug log records the key paths
  (never values) so a new agent's reporting format is diagnosable instead of
  silently surfacing "usage unavailable".

## 0.9.2

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

- Updated dependencies [a3ce7cb]
  - @pwrdrvr/agent-core@0.1.3

## 0.9.1

### Patch Changes

- 95af638: Sanitize inbound ACP notifications so a non-spec `rawInput`/`rawOutput` doesn't
  get the whole `session/update` rejected. The official ACP library (adopted in
  0.9.0) validates inbound notifications and types tool_call(\_update)
  `rawInput`/`rawOutput` as `z.record` (a plain object). Real agents don't honor
  that — Kimi sends `rawOutput` as a JSON STRING (a tool's text result) or an
  ARRAY — so validation failed with `-32602 Invalid params`, the library logged
  "Error handling notification", and the tool's status update was silently
  dropped (our old hand-rolled connection never validated, so it tolerated this).
  `AcpConnection` now wraps the agent's stdout and coerces a non-object
  `rawInput`/`rawOutput` to `{ value: <orig> }` (data preserved, schema
  satisfied), dropping an explicit `null`, before the library frames + validates
  the line. Plain-object values pass through untouched.

## 0.9.0

### Minor Changes

- 9b7745a: Adopt the official `@zed-industries/agent-client-protocol` library for the ACP
  wire layer. The hand-rolled ACP message types + JSON-RPC client calls are
  replaced by the library's `ClientSideConnection` + `ndJsonStream` (spec-tracked
  types, schema validation, maintained upstream). We keep what the library
  doesn't do: discovery, process spawn/lifetime, the normalizer (ACP → neutral
  events), and per-agent quirks.

  BREAKING: `AcpStdioJsonRpcTransport` (+ `AcpStdioJsonRpcTransportOptions`) is
  removed. Construct `AcpConnection` instead — same options (`command` / `args` /
  `env` / `logger`) and the same `AcpJsonRpcTransport` interface, so
  `AcpAgentClient` / `AcpOneShotClient` / pool are unchanged. Non-standard methods
  (`session/set_config_option`) and vendor notifications (Grok's
  `session_summary_generated`) ride the library's `extMethod` / `extNotification`.

  Verified live end-to-end against grok 0.2.22 and kimi 0.11.0 (session +
  streamed assistant reply through the new path).

## 0.8.0

### Minor Changes

- e052b42: Implement `AcpAgentClient.archiveThread(threadId)`. ACP has no protocol-level
  session delete/archive (sessions are connection-scoped; the spec offers only
  `session/cancel`), so unlike the Codex backend there's no remote call to make —
  but the client now releases the session LOCALLY on archive: it best-effort
  cancels an in-flight turn, then drops the `AcpSessionState` + protocol-id
  mapping. Previously archiveThread was unimplemented, so a long-lived pooled
  client (one process shared across surfaces) accumulated a dead session for every
  closed chat until the whole client was closed. Idempotent; a later
  `reopenThread` re-establishes a fresh session under the same threadId.

## 0.7.0

### Minor Changes

- 836d32f: Remove the client's `autoApproveConfiguredMcpTools` option (and its server-name
  matcher). The ACP client no longer makes any trust decision of its own — every
  `session/request_permission` is forwarded to the host's `onApprovalRequest`
  handler, now enriched with the context the raw ACP params lack: the resolved
  `threadId` and `mcpServerNames` (the union of the client's default servers and
  every live session's per-thread servers). The host owns the policy and can
  recognize a tool call that targets a server IT configured.

  This fixes the fragility where the kit guessed which permission requests were
  host MCP tools via a Gemini-shaped string heuristic that broke for other CLIs
  (Kimi, Grok). Hosts now match against their OWN known servers/tools, which is
  both more precise and the correct layer for a trust decision.

  BREAKING: consumers relying on `autoApproveConfiguredMcpTools` must instead
  register an `onApprovalRequest` handler and approve based on the new
  `params.mcpServerNames`. An `"approved"` decision now prefers the broadest
  allow option (session-wide server allow) so a host pre-approving its own tools
  isn't re-prompted every call.

## 0.6.1

### Patch Changes

- Fix MCP tool auto-approval for pooled/shared clients. `autoApproveConfiguredMcpTools`
  matched the permission request's tool against the CLIENT-level `mcpServers`
  default — but a shared client (one process per agent serving multiple surfaces)
  attaches its tools PER-THREAD, so that default is empty and every MCP tool
  request fell through to "no handler → cancelled". The client now tracks each
  session's MCP server names and auto-approves against the union of the default +
  all live sessions, so per-thread tools are approved. Verified live: Gemini's
  tool call on a per-thread-MCP session is auto-approved, not cancelled.

## 0.6.0

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
