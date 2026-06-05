# @pwrdrvr/agent-acp

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
