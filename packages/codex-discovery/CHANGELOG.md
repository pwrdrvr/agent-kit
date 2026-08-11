# @pwrdrvr/codex-discovery

## 0.1.6

### Patch Changes

- f1e21eb: Discover Windows ACP agents through real PATH/PATHEXT candidates and launch `.cmd`/`.bat` shims safely through a shared ComSpec invocation for discovery, ACP connections, and generic stdio transports.
- Updated dependencies [f1e21eb]
  - @pwrdrvr/agent-transport@0.1.7

## 0.1.5

### Patch Changes

- ad8203b: Launch Windows `.cmd` and `.bat` command shims through `cmd.exe` with explicit argument escaping for discovery probes, auth status checks, and login, including npm and NVM-installed Codex launchers.

## 0.1.4

### Patch Changes

- d46c9dd: Discover Codex CLI binaries inside the renamed ChatGPT.app macOS bundle and common Homebrew paths while retaining legacy Codex.app bundle discovery.

## 0.1.3

### Patch Changes

- Updated dependencies
  - @pwrdrvr/agent-core@0.2.0
