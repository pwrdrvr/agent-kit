# @pwrdrvr/codex-discovery

## 0.4.0

### Minor Changes

- 2091170: Resolve Windows commands through PATHEXT instead of the bare, unstartable command name.

  `buildPathCommandNames` put the extensionless name FIRST in the list `resolvePathCommand` walks per PATH directory, and the scan returns its first hit. npm installs three shims side by side — `codex` (an sh script, for Git Bash), `codex.cmd`, and `codex.ps1` — so in any npm or nvm-windows bin directory the scan stopped on the sh script and never reached `codex.cmd`. Measured against a working Codex 0.146.0 install at `C:\nvm4w\nodejs\`: `where codex` lists the sh script first, discovery picked it, and the tool was reported missing. (`.PS1` is not in the default PATHEXT, so the `.ps1` was never the problem — the bare name was.)

  On win32 the bare name is no longer a candidate at all: `CreateProcess` appends `.exe` to an extensionless name, so such a file cannot be launched by `child_process` regardless of where it sits in the list. Only a command carrying some other, non-PATHEXT extension (`tool.ps1`) keeps the verbatim name, tried last, so a caller who named a specific file can still discover it. A command that already ends in a PATHEXT extension still resolves to itself. PATH and PATHEXT are now both read case-insensitively on win32. **POSIX resolution is byte-for-byte unchanged** — the bare name is correct and the only option there.

  This is not Codex-specific: `discoverCommands` is generic, so every consumer resolving a tool (`git`, `gh`, …) on a Windows npm-shim layout was hitting the same defect.

  `pathIsExecutable` is fixed in the same pass rather than left as a known weakness. It used `access(X_OK)`, which on Windows has no execute bit to consult and degrades to "does this file exist" — it answered `true` for a README, so `candidate.executable` on win32 was asserting nothing. It now judges by PATHEXT there (the rule `CreateProcess` and `cmd.exe` actually apply) and confirms existence separately; POSIX still asks the filesystem. It takes a new optional second argument, `PathIsExecutableOptions` (`env`, `platform`), defaulting to `process.env` / `process.platform`, so the existing one-argument calls keep compiling. Discovery still ORs this with "the version probe actually ran", so a candidate proven to execute is unaffected.

  Backward compatible: no exported name changed meaning off Windows, and nothing was removed. Consumers pinned to `^0.1.6` need to widen the range to pick this up.

## 0.3.0

### Minor Changes

- 9dee193: Let callers scope the well-known Codex install locations that discovery probes. `discoverCodexCommands` and `resolveCodexCommand` accept an optional `installCandidatePaths` list, which _replaces_ the platform defaults (spread `getCodexInstallCandidatePaths` into your own list to extend them instead), plus an optional `homeDir` used to expand the default list's user-local entries. `getCodexInstallCandidatePaths` is now exported, builds paths with the rules of the platform it is given rather than the host's, and falls back to the real home directory when handed a blank one. Both options default to today's behavior, so existing callers are unaffected.

## 0.2.0

### Minor Changes

- e7678de: Report a probe that ran out of time as "did not answer in time" instead of "not installed", and let callers own the budget.

  `codex-discovery`: the `<command> --version` probe no longer hardcodes 2s. `DEFAULT_COMMAND_VERSION_TIMEOUT_MS` (10s) is exported and overridable per call via `versionTimeoutMs` on `DiscoverCommandOptions`, `discoverCodexCommands`, and `resolveCodexCommand`; 2s sat on top of a warm npm `codex.cmd` (~1.5s for its `cmd.exe → node → shim` chain), so a loaded machine crossed it. The now-exported `readCommandVersion` returns a `CommandVersionProbeOutcome` (`ok`, `version_not_reported`, `not_found`, `not_executable`, `timed_out`, `aborted`, `failed`), and that outcome rides on every discovery candidate and on `ResolvedCommandCandidate`, so a consumer gating on version can tell an unfinished measurement from a missing CLI and re-probe on its own budget (`isUnprovenVersionProbe` names that set). A timed-out candidate is no longer labelled `not_executable`, and is no longer filtered out of the snapshot. `CodexCliNotInstalledError` carries `timedOutCommands` / `probeTimedOut` when a timeout — not a missing binary — is why nothing resolved. All entry points accept an `AbortSignal`; an aborted run yields a snapshot with `error: COMMAND_DISCOVERY_ABORTED` (and `CodexDiscoveryAbortedError` from `resolveCodexCommand`) rather than a false "not installed". `collectCodexStatus` / `checkCodexAuthStatus` gain a budget (`DEFAULT_CODEX_STATUS_TIMEOUT_MS`, 10s) where they previously had none at all and could hang forever, and both report a `CodexStatusOutcome` (`answered` / `timed_out` / `aborted` / `spawn_failed`) so a slow — or caller-cancelled — check is not read as a signed-out profile.

  `agent-acp`: local discovery keeps a candidate whose probe ran out of budget visible as `reason: "probe-timed-out"` even on the default path, rather than dropping its whole group and reporting the agent as not installed. `AcpConnection.request` now enforces the `timeoutMs` it has always accepted and silently ignored — an agent that took a request and went quiet hung the caller indefinitely, including the 30s `initialize` and 1h `session/prompt` budgets `AcpAgentClient` passes. Local discovery's probe budget is configurable via `probeTimeoutMs` (`DEFAULT_ACP_PROBE_TIMEOUT_MS`, unchanged at 5s) with `AbortSignal` support, and a probe that overran is reported as `reason: "probe-timed-out"` rather than `version-probe-failed`.

  `agent-client`: `CodexThreadClient` and `CodexOneShotClient` resolve their binary through discovery on first connect, so they gain `commandVersionTimeoutMs` to size that probe. Without it a host could only take the default, and an overrun surfaced as `CodexCliNotInstalledError` from the first call.

  All three packages' probes now settle within their budget even when the child cannot be killed — on Windows a `.cmd` shim runs under `cmd.exe`, and killing the wrapper can leave a `node` grandchild holding the stdio pipes open, so waiting on process exit could hang past any timeout.

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
