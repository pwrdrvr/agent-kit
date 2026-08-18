# @pwrdrvr/codex-discovery

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
