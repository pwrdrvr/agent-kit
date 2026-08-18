// Codex-CLI specifics layered on the generic command-discovery engine:
// minimum-version gate, full semver+prerelease comparison, platform install
// locations, Homebrew version-without-execution, and the typed
// `CodexCliNotInstalledError`.
//
// Ported faithfully from PwrAgnt
// (apps/desktop/src/main/settings/codex-discovery.ts). The only intentional
// change is the env override name: `PWRAGENT_CODEX_COMMAND` → `PWRDRVR_CODEX_COMMAND`.

import os from "node:os";
import path from "node:path";
import { realpath } from "node:fs/promises";
import {
  COMMAND_DISCOVERY_ABORTED,
  discoverCommands,
  pathIsExecutable,
  type ResolvedCommandCandidate,
} from "./command-discovery";
import type {
  CodexCandidateSource,
  CodexDiscoverySnapshot,
} from "./types";

/** Env var the host can set to force a specific Codex binary. */
export const CODEX_COMMAND_ENV = "PWRDRVR_CODEX_COMMAND";

export const MINIMUM_CODEX_CLI_VERSION = "0.125.0";

export type ResolvedCodexCommandCandidate = {
  command: string;
  source: CodexCandidateSource;
  version?: string | undefined;
};
export { pathIsExecutable };

function parseCodexVersionOutput(output: string): string | undefined {
  return output.match(/\b(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)\b/)?.[1];
}

function parseVersion(value?: string): {
  major: number;
  minor: number;
  patch: number;
  prerelease: string[];
} | undefined {
  const match = value?.match(/^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/);
  if (!match) {
    return undefined;
  }

  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4]?.split(".") ?? [],
  };
}

function comparePrerelease(left: string[], right: string[]): number {
  if (left.length === 0 && right.length === 0) {
    return 0;
  }
  if (left.length === 0) {
    return 1;
  }
  if (right.length === 0) {
    return -1;
  }

  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const leftPart = left[index];
    const rightPart = right[index];
    if (leftPart === undefined) {
      return -1;
    }
    if (rightPart === undefined) {
      return 1;
    }

    const leftNumber = /^\d+$/.test(leftPart) ? Number(leftPart) : undefined;
    const rightNumber = /^\d+$/.test(rightPart) ? Number(rightPart) : undefined;
    if (leftNumber !== undefined && rightNumber !== undefined) {
      if (leftNumber !== rightNumber) {
        return Math.sign(leftNumber - rightNumber);
      }
      continue;
    }
    if (leftNumber !== undefined) {
      return -1;
    }
    if (rightNumber !== undefined) {
      return 1;
    }
    if (leftPart !== rightPart) {
      return leftPart.localeCompare(rightPart);
    }
  }

  return 0;
}

export function compareCodexCliVersions(left?: string, right?: string): number {
  const leftVersion = parseVersion(left);
  const rightVersion = parseVersion(right);
  if (!leftVersion && !rightVersion) {
    return 0;
  }
  if (!leftVersion) {
    return -1;
  }
  if (!rightVersion) {
    return 1;
  }

  for (const key of ["major", "minor", "patch"] as const) {
    if (leftVersion[key] !== rightVersion[key]) {
      return Math.sign(leftVersion[key] - rightVersion[key]);
    }
  }

  return comparePrerelease(leftVersion.prerelease, rightVersion.prerelease);
}

function validateCodexCliVersion(version: string): string | undefined {
  return compareCodexCliVersions(version, MINIMUM_CODEX_CLI_VERSION) < 0
    ? "codex_too_old"
    : undefined;
}

/**
 * Well-known install locations for the Codex CLI, used as auto-candidates
 * alongside the PATH lookup. Platform-aware: macOS gets `ChatGPT.app` and
 * `Codex.app` resource bundles plus common Homebrew prefixes, Linux gets the
 * standard FHS dirs plus the common user-local Node/Rust/Bun toolchain
 * locations that aren't typically on an Electron-spawned process's PATH.
 * Note that this order does NOT decide which install wins: `discoverCommands`
 * ranks auto-candidates by version (newest first), so list order only breaks
 * ties between equal versions. Callers that must pin a specific binary should
 * use the `config` command or the `PWRDRVR_CODEX_COMMAND` env override, both
 * of which outrank every auto-candidate.
 */
export function getCodexInstallCandidatePaths(
  platform: NodeJS.Platform,
  homeDir?: string,
): string[] {
  // Resolved here rather than through a default parameter: a default only
  // fires on `undefined`, and this is public API. An empty string (a host
  // writing `process.env.HOME ?? ""`, or `os.homedir()` itself when HOME is
  // set but empty) would otherwise yield relative entries like
  // `.local/bin/codex`, which discovery resolves — and executes — against
  // `process.cwd()`.
  const home = homeDir?.trim() ? homeDir : os.homedir();
  // Join with the rules of the platform being described, not the host's: the
  // `platform` argument makes cross-platform calls legitimate, and
  // `command-discovery` already applies the target platform's path semantics
  // when it probes these candidates.
  const join = platform === "win32" ? path.win32.join : path.posix.join;
  if (platform === "darwin") {
    return [
      "/Applications/ChatGPT.app/Contents/Resources/codex",
      "/Applications/Codex.app/Contents/Resources/codex",
      join(home, "Applications/ChatGPT.app/Contents/Resources/codex"),
      join(home, "Applications/Codex.app/Contents/Resources/codex"),
      "/opt/homebrew/bin/codex",
      "/usr/local/bin/codex",
    ];
  }
  if (platform === "linux") {
    return [
      // System-wide installs (the typical "apt install", "rpm install",
      // or homebrew-on-linux destination).
      "/usr/bin/codex",
      "/usr/local/bin/codex",
      "/opt/codex/bin/codex",
      // Ubuntu Snap installs land here when installed via `snap install
      // codex`. The snap-wrapper exec is a shim that delegates to the
      // real binary under `/snap/codex/current/`, but `/snap/bin/codex`
      // is what shows up on PATH for a normal shell.
      "/snap/bin/codex",
      // User-local installs. Electron's spawned-process PATH on Linux
      // does NOT typically include `~/.local/bin` or any of the per-
      // language toolchain bin dirs (npm-global, pnpm, bun, cargo),
      // so these need explicit auto-candidates to be discoverable
      // without the operator setting CODEX_COMMAND or `PATH`.
      join(home, ".local/bin/codex"),
      join(home, ".npm-global/bin/codex"),
      join(home, ".local/share/pnpm/codex"),
      join(home, ".bun/bin/codex"),
      join(home, ".cargo/bin/codex"),
      // Linuxbrew on Linux. Two common prefixes:
      "/home/linuxbrew/.linuxbrew/bin/codex",
      join(home, ".linuxbrew/bin/codex"),
    ];
  }
  if (platform === "win32") {
    // Windows isn't a user-reported gap yet, but include the obvious
    // npm + LOCALAPPDATA installs so the discovery snapshot is
    // symmetric. The npm-global `.cmd` shim is what gets executed by
    // `spawn` on win32.
    return [
      join(home, "AppData/Roaming/npm/codex.cmd"),
      join(home, "AppData/Local/Programs/codex/codex.exe"),
    ];
  }
  // Other Unix flavors (freebsd, openbsd, sunos) — fall back to the FHS
  // basics, no user-local guesses.
  return ["/usr/bin/codex", "/usr/local/bin/codex"];
}

async function inspectCodexCandidateBeforeVersionProbe(params: {
  command: string;
  platform: NodeJS.Platform;
}): Promise<{
  version?: string | undefined;
  failureReason?: string | undefined;
  skipVersionProbe?: boolean | undefined;
} | undefined> {
  if (params.platform !== "darwin") {
    return undefined;
  }

  const version = await readHomebrewCodexVersionWithoutExecution(params.command);
  if (!version) {
    return undefined;
  }

  return {
    version,
    failureReason: validateCodexCliVersion(version),
    skipVersionProbe: true,
  };
}

async function readHomebrewCodexVersionWithoutExecution(command: string): Promise<string | undefined> {
  const candidatePaths = [command];
  try {
    const resolved = await realpath(command);
    if (resolved !== command) {
      candidatePaths.push(resolved);
    }
  } catch {
    // The caller already checked existence. If realpath fails, fall back to the
    // original path and the normal version probe.
  }

  for (const candidatePath of candidatePaths) {
    const homebrewVersion = readHomebrewCodexVersionFromPath(candidatePath);
    if (homebrewVersion) {
      return homebrewVersion;
    }
  }

  return undefined;
}

function readHomebrewCodexVersionFromPath(candidatePath: string): string | undefined {
  const normalized = candidatePath.replace(/\\/g, "/");
  const match = normalized.match(
    /\/(?:Caskroom|Cellar)\/codex\/(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)(?:\/|$)/,
  );
  return match?.[1];
}

/**
 * Narrows or redirects the well-known install locations probed as
 * auto-candidates alongside the PATH lookup. Both fields are optional and
 * default to today's behavior, so existing callers are unaffected.
 */
export type CodexInstallCandidateOptions = {
  /**
   * Install locations to probe, *replacing* (not extending) the platform
   * defaults. Defaults to `getCodexInstallCandidatePaths(platform, homeDir)`;
   * to extend instead, spread that helper's result into your own list. Pass
   * `[]` to probe nothing but PATH and the caller-supplied env/config
   * commands.
   *
   * Entries must be absolute paths. A bare name is resolved through `PATH`
   * like any other command, which reports it as an `application` candidate at
   * whatever path the lookup happened to find.
   */
  installCandidatePaths?: readonly string[] | undefined;
  /**
   * Home directory used to expand the user-local entries of the default
   * candidate list. Defaults to `os.homedir()`. Ignored when
   * `installCandidatePaths` is supplied.
   */
  homeDir?: string | undefined;
};

export type DiscoverCodexCommandsParams = {
  configuredCommand?: string | undefined;
  env?: NodeJS.ProcessEnv | undefined;
  platform?: NodeJS.Platform | undefined;
  /** Budget for each `codex --version` probe. Defaults to
   *  `DEFAULT_COMMAND_VERSION_TIMEOUT_MS`. */
  versionTimeoutMs?: number | undefined;
  /** Abandon in-flight probes (discovery re-triggered, app quitting). The
   *  snapshot then carries `error: COMMAND_DISCOVERY_ABORTED`. */
  signal?: AbortSignal | undefined;
} & CodexInstallCandidateOptions;

export async function discoverCodexCommands(
  params?: DiscoverCodexCommandsParams,
): Promise<CodexDiscoverySnapshot> {
  const env = params?.env ?? process.env;
  const envOverride = env[CODEX_COMMAND_ENV]?.trim();
  const configuredCommand = params?.configuredCommand?.trim();

  const resolvedPlatform = params?.platform ?? process.platform;
  // An explicit list replaces the defaults outright, which is also why
  // `homeDir` — whose only job is expanding the default list's user-local
  // entries — has nothing to act on once one is supplied.
  const installCandidatePaths =
    params?.installCandidatePaths
    ?? getCodexInstallCandidatePaths(resolvedPlatform, params?.homeDir);
  return discoverCommands<CodexCandidateSource>({
    env,
    platform: params?.platform,
    fixedCandidates: [
      { command: envOverride, source: "env" },
      { command: configuredCommand, source: "config" },
    ],
    autoCandidates: [
      { command: "codex", source: "path" },
      ...installCandidatePaths.map(
        (candidatePath) => ({
          command: candidatePath,
          source: "application" as const,
        }),
      ),
    ],
    parseVersion: parseCodexVersionOutput,
    compareVersions: compareCodexCliVersions,
    validateVersion: validateCodexCliVersion,
    preflightCandidate: ({ command, platform }) =>
      inspectCodexCandidateBeforeVersionProbe({ command, platform }),
    versionTimeoutMs: params?.versionTimeoutMs,
    signal: params?.signal,
  });
}

/**
 * Thrown by `resolveCodexCommand` when discovery finds no executable
 * Codex CLI on this machine. Callers catch this to surface a clean
 * "Codex CLI not installed" state instead of attempting a spawn that
 * would `ENOENT`. Discovery already searched PATH plus whichever install
 * locations were in scope, so a `spawn("codex")` fallback would just repeat
 * the same lookup that already failed. Note that a caller which narrowed
 * `installCandidatePaths` narrowed that search too: this error then means
 * "not found where you told us to look", not "not installed".
 */
export class CodexCliNotInstalledError extends Error {
  /**
   * Commands whose `--version` probe overran its budget instead of failing
   * outright. NON-EMPTY means "we could not tell", not "not installed": retry
   * on a larger `versionTimeoutMs` before telling anyone to install Codex.
   */
  readonly timedOutCommands: string[];

  constructor(
    message = "codex CLI not found on PATH or in the install locations that were searched",
    options: { timedOutCommands?: string[] | undefined } = {},
  ) {
    super(message);
    this.name = "CodexCliNotInstalledError";
    this.timedOutCommands = options.timedOutCommands ?? [];
  }

  /** True when a probe timeout — not a missing binary — is why nothing resolved. */
  get probeTimedOut(): boolean {
    return this.timedOutCommands.length > 0;
  }
}

/**
 * Thrown by `resolveCodexCommand` when the caller's `AbortSignal` fired mid-
 * discovery. Deliberately NOT a `CodexCliNotInstalledError`: an abandoned run
 * found nothing because it stopped looking, which is not evidence about what
 * is installed.
 */
export class CodexDiscoveryAbortedError extends Error {
  constructor(message = "codex discovery aborted before a command was resolved") {
    super(message);
    this.name = "CodexDiscoveryAbortedError";
  }
}

export async function resolveCodexCommand(
  params: {
    command: string;
    env: NodeJS.ProcessEnv;
    platform?: NodeJS.Platform | undefined;
    /** Budget for each `codex --version` probe. Defaults to
     *  `DEFAULT_COMMAND_VERSION_TIMEOUT_MS`. */
    versionTimeoutMs?: number | undefined;
    signal?: AbortSignal | undefined;
  } & CodexInstallCandidateOptions,
): Promise<ResolvedCommandCandidate<CodexCandidateSource>> {
  // Spread rather than copy field-by-field: `command` is the only key that
  // needs translating, so `env`, `platform`, the probe budget/signal and the
  // install-candidate options all reach discovery without being re-listed —
  // and anything added to those groups later does too.
  const { command, ...forwarded } = params;
  const configuredCommand =
    command.trim() && command.trim() !== "codex" ? command.trim() : undefined;
  const discovery = await discoverCodexCommands({
    ...forwarded,
    configuredCommand,
  });
  const selected = discovery.candidates.find((candidate) => candidate.selected);
  const rejectedOldCodex = discovery.candidates.find(
    (candidate) => candidate.failureReason === "codex_too_old",
  );

  // Abort first: an abandoned run may still have "selected" something whose
  // version never got measured, and handing that back would silently skip the
  // MINIMUM_CODEX_CLI_VERSION gate on a result the caller already gave up on.
  if (discovery.error === COMMAND_DISCOVERY_ABORTED) {
    throw new CodexDiscoveryAbortedError();
  }

  if (selected) {
    return {
      command: selected.command,
      source: selected.source,
      version: selected.version,
      // Carries `timed_out` when the command resolved but its version is
      // UNKNOWN — a version-gating caller should re-probe, not demote it.
      versionProbeOutcome: selected.versionProbeOutcome,
    };
  }

  if (rejectedOldCodex) {
    throw new Error(
      `Codex CLI ${rejectedOldCodex.version ?? "unknown"} is older than the minimum supported version ${MINIMUM_CODEX_CLI_VERSION}: ${rejectedOldCodex.command}`,
    );
  }

  // A probe that ran out of budget is not evidence of a missing CLI. Keep the
  // same error type so existing catches still work, but say what actually
  // happened and hand back the commands worth retrying.
  const timedOutCommands = discovery.candidates
    .filter((candidate) => candidate.versionProbeOutcome === "timed_out")
    .map((candidate) => candidate.command);
  if (timedOutCommands.length > 0) {
    throw new CodexCliNotInstalledError(
      `codex CLI did not answer --version in time (${timedOutCommands.join(", ")}); it may be installed but too slow to confirm`,
      { timedOutCommands },
    );
  }

  throw new CodexCliNotInstalledError();
}
