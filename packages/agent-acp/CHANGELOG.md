# @pwrdrvr/agent-acp

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
