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
  type ResolvedCommandCandidate,
  buildCommandDiscoveryCandidate,
  discoverCommands,
  resolveDiscoveredCommand,
  pathIsExecutable,
} from "./command-discovery";

export {
  CODEX_COMMAND_ENV,
  MINIMUM_CODEX_CLI_VERSION,
  type ResolvedCodexCommandCandidate,
  compareCodexCliVersions,
  discoverCodexCommands,
  resolveCodexCommand,
  CodexCliNotInstalledError,
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
  collectCodexStatus,
  checkCodexAuthStatus,
  parseCodexLoginPrompt,
  CodexLoginManager,
  type CodexLoginManagerOptions,
  type StartCodexLoginParams,
  startCodexProfileLoginProcess,
} from "./codex-login";
