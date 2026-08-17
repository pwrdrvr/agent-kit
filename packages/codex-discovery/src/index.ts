// @pwrdrvr/codex-discovery — discover local Codex CLI binaries (version-ranked),
// enumerate auth profiles, and drive login / relogin. Electron-free: the host
// injects a `Logger` and an `OpenExternal` callback.

export * from "./types";

export {
  // generic command-discovery engine
  type CommandDiscoveryCandidate,
  type CommandDiscoverySnapshot,
  type CommandDiscoveryInput,
  type DiscoverCommandOptions,
  type CommandDiscoveryPreflightResult,
  type CommandVersionProbeOutcome,
  type CommandVersionProbeResult,
  type ReadCommandVersionOptions,
  type ResolvedCommandCandidate,
  COMMAND_DISCOVERY_ABORTED,
  DEFAULT_COMMAND_VERSION_TIMEOUT_MS,
  buildCommandDiscoveryCandidate,
  discoverCommands,
  isUnprovenVersionProbe,
  readCommandVersion,
  resolveDiscoveredCommand,
  pathIsExecutable,
} from "./command-discovery";

export {
  CODEX_COMMAND_ENV,
  MINIMUM_CODEX_CLI_VERSION,
  type DiscoverCodexCommandsParams,
  type ResolvedCodexCommandCandidate,
  compareCodexCliVersions,
  discoverCodexCommands,
  resolveCodexCommand,
  CodexCliNotInstalledError,
  CodexDiscoveryAbortedError,
} from "./codex-discovery";

export {
  CODEX_HOME_ENV,
  resolveDefaultCodexHome,
  resolveCodexProfileRoot,
  resolveCodexHomeForProfile,
  createCodexAuthProfile,
  discoverCodexAuthProfiles,
  readCodexAuthInfo,
} from "./codex-profiles";

export {
  normalizeProfileName,
  isValidProfileName,
  isCanonicalProfileName,
} from "./profile-names";

export {
  DEFAULT_CODEX_STATUS_TIMEOUT_MS,
  collectCodexStatus,
  checkCodexAuthStatus,
  parseCodexLoginPrompt,
  CodexLoginManager,
  type CodexLoginManagerOptions,
  type CollectCodexStatusOptions,
  type StartCodexLoginParams,
  startCodexProfileLoginProcess,
} from "./codex-login";
