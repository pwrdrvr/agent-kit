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
 * Returned in priority order (system-wide first, user-local second) so the
 * discovery prefers the canonical install when both are present.
 */
export function getCodexInstallCandidatePaths(
  platform: NodeJS.Platform,
  homeDir = os.homedir(),
): string[] {
  if (platform === "darwin") {
    return [
      "/Applications/ChatGPT.app/Contents/Resources/codex",
      "/Applications/Codex.app/Contents/Resources/codex",
      path.join(homeDir, "Applications/ChatGPT.app/Contents/Resources/codex"),
      path.join(homeDir, "Applications/Codex.app/Contents/Resources/codex"),
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
      path.join(homeDir, ".local/bin/codex"),
      path.join(homeDir, ".npm-global/bin/codex"),
      path.join(homeDir, ".local/share/pnpm/codex"),
      path.join(homeDir, ".bun/bin/codex"),
      path.join(homeDir, ".cargo/bin/codex"),
      // Linuxbrew on Linux. Two common prefixes:
      "/home/linuxbrew/.linuxbrew/bin/codex",
      path.join(homeDir, ".linuxbrew/bin/codex"),
    ];
  }
  if (platform === "win32") {
    // Windows isn't a user-reported gap yet, but include the obvious
    // npm + LOCALAPPDATA installs so the discovery snapshot is
    // symmetric. The npm-global `.cmd` shim is what gets executed by
    // `spawn` on win32.
    return [
      path.join(homeDir, "AppData/Roaming/npm/codex.cmd"),
      path.join(homeDir, "AppData/Local/Programs/codex/codex.exe"),
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

export async function discoverCodexCommands(params?: {
  configuredCommand?: string | undefined;
  env?: NodeJS.ProcessEnv | undefined;
  platform?: NodeJS.Platform | undefined;
}): Promise<CodexDiscoverySnapshot> {
  const env = params?.env ?? process.env;
  const envOverride = env[CODEX_COMMAND_ENV]?.trim();
  const configuredCommand = params?.configuredCommand?.trim();

  const resolvedPlatform = params?.platform ?? process.platform;
  return discoverCommands<CodexCandidateSource>({
    env,
    platform: params?.platform,
    fixedCandidates: [
      { command: envOverride, source: "env" },
      { command: configuredCommand, source: "config" },
    ],
    autoCandidates: [
      { command: "codex", source: "path" },
      ...getCodexInstallCandidatePaths(resolvedPlatform).map(
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
  });
}

/**
 * Thrown by `resolveCodexCommand` when discovery finds no executable
 * Codex CLI on this machine. Callers catch this to surface a clean
 * "Codex CLI not installed" state instead of attempting a spawn that
 * would `ENOENT`. Discovery already searched PATH plus the platform-
 * specific install locations, so a `spawn("codex")` fallback would just
 * repeat the same lookup that already failed.
 */
export class CodexCliNotInstalledError extends Error {
  constructor(message = "codex CLI not found on PATH or in known install locations") {
    super(message);
    this.name = "CodexCliNotInstalledError";
  }
}

export async function resolveCodexCommand(params: {
  command: string;
  env: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
}): Promise<ResolvedCommandCandidate<CodexCandidateSource>> {
  const configuredCommand =
    params.command.trim() && params.command.trim() !== "codex"
      ? params.command.trim()
      : undefined;
  const discovery = await discoverCodexCommands({
    configuredCommand,
    env: params.env,
    platform: params.platform,
  });
  const selected = discovery.candidates.find((candidate) => candidate.selected);
  const rejectedOldCodex = discovery.candidates.find(
    (candidate) => candidate.failureReason === "codex_too_old",
  );

  if (selected) {
    return {
      command: selected.command,
      source: selected.source,
      version: selected.version,
    };
  }

  if (rejectedOldCodex) {
    throw new Error(
      `Codex CLI ${rejectedOldCodex.version ?? "unknown"} is older than the minimum supported version ${MINIMUM_CODEX_CLI_VERSION}: ${rejectedOldCodex.command}`,
    );
  }

  throw new CodexCliNotInstalledError();
}
