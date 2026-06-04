# @pwrdrvr/agent-transport

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

## 0.1.3

### Patch Changes

- Shared login-shell PATH hydration. `resolveInteractiveLoginShellEnv` /
  `mergeLoginShellEnvIntoEnv` / `hydrateProcessEnvFromLoginShell` spawn the user's
  interactive login shell (`$SHELL -ilc`), capture its env, and merge it into a
  process environment — so a Finder/Dock-launched desktop app sees the real
  `PATH` (nvm / Homebrew) instead of launchd's minimal one, and bare-command
  spawns for agent discovery (ACP) and Codex resolve. Logger is injectable
  (agent-core `Logger`, no-op default); no-op on Windows. Lives in agent-transport
  (node-only process plumbing) so every @pwrdrvr desktop host shares one tested
  implementation instead of copying it.
