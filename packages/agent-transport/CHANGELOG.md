# @pwrdrvr/agent-transport

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
