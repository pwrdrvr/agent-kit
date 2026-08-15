// Probe which ACP CLIs are installed locally. STRATEGY-DRIVEN: iterates the
// strategy table and runs each strategy's `discoveryProbe`. Adding a 5th agent
// (a new strategy entry) surfaces it through discovery with ZERO changes here.
//
// Two granularities:
//   • `discoverLocalAcpAgentInstances` — returns EVERY installed instance of
//     each agent (each executable on `PATH` + the strategy's fallback paths +
//     an optional override that passes the probe), with its parsed version and
//     where it was found. A host UI can list them all and let the user pick.
//     Hosts that opt in can also receive detected candidates rejected by the
//     probe, so they can explain why a known CLI cannot be used.
//   • `discoverLocalAcpAgents` — the original first-match-per-agent view, kept
//     for back-compat. Implemented on top of the instance view.
//
// Ported from PwrAgnt acp-local-discovery.ts, generalized so the per-agent probe
// details live in the strategy, not inline branches.

import { execFile as execFileCallback } from "node:child_process";
import { readdirSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import {
  createCommandInvocation,
  prependCommandDirToPath
} from "@pwrdrvr/agent-transport";
import { BUILT_IN_ACP_STRATEGIES } from "../strategies/index";
import type {
  AcpAgentStrategy,
  AcpAgentStrategy as Strategy,
  LocalAcpAgentProbe,
  LocalAcpProbeResult
} from "../strategies/strategy-types";

const execFile = promisify(execFileCallback);

export type { LocalAcpAgentProbe, LocalAcpProbeResult } from "../strategies/strategy-types";

/** How a discovered instance's executable path was located. */
export type AcpAgentInstanceSource = "override" | "path" | "fallback";

/** One installed executable of an agent that passed the probe. */
export type DiscoveredAcpAgentInstance = {
  /** Resolved command/path that passed the probe. */
  command: string;
  /** Parsed CLI version, when the version probe yielded one. */
  version?: string;
  /** Where this candidate came from (user override, `PATH`, or a fallback path). */
  source: AcpAgentInstanceSource;
};

/** A detected executable that did not satisfy a strategy's discovery probe.
 *  It is diagnostic-only: hosts must never use it to launch an ACP session. */
export type RejectedAcpAgentInstance = {
  command: string;
  /** Parsed from successful `--version` output when available. */
  version?: string;
  source: AcpAgentInstanceSource;
  reason: "version-probe-failed" | "acp-probe-failed" | "acp-help-mismatch";
};

/** Every installed instance of one agent found on this machine. */
export type DiscoveredAcpAgentGroup = {
  strategyId: string;
  backendId: string;
  name: string;
  /** Spawn args that put it into ACP stdio mode (same for every instance). */
  args: string[];
  /** Extra env to set at launch (same for every instance). */
  env: Record<string, string>;
  /** All instances that passed the probe, in candidate order (override → PATH → fallback). */
  instances: DiscoveredAcpAgentInstance[];
  /** Detected candidates that failed the version or ACP-capability probe. Only
   *  populated when `includeRejectedCandidates` is enabled. */
  rejectedInstances?: RejectedAcpAgentInstance[];
  discoveredAt: number;
};

export type DiscoveredAcpAgent = {
  strategyId: string;
  backendId: string;
  name: string;
  version?: string;
  /** Resolved command that passed the probe (may be a fallback path). */
  command: string;
  /** Spawn args that put it into ACP stdio mode. */
  args: string[];
  /** Extra env to set at launch. */
  env: Record<string, string>;
  discoveredAt: number;
};

/** Lists every executable named `command` across the dirs in `env.PATH`,
 *  in `PATH` order (the `which -a` view). */
export type AcpPathExecutableLister = (
  command: string,
  env: NodeJS.ProcessEnv
) => string[];

export type LocalAcpDiscoveryOptions = {
  probe?: LocalAcpAgentProbe;
  now?: () => number;
  /** Strategy table to probe (built-ins by default). */
  strategies?: readonly AcpAgentStrategy[];
  /** Per-strategy command override (tried before the strategy's own candidates). */
  overrides?: Record<string, string>;
  /** Env used both for PATH enumeration and (by the default probe) for spawns. */
  env?: NodeJS.ProcessEnv;
  /** Injectable `PATH` executable lister (real-fs scan by default). */
  listExecutables?: AcpPathExecutableLister;
  /** Include candidates known to exist but rejected by a discovery probe.
   *  Defaults false to preserve the legacy installed-only result. */
  includeRejectedCandidates?: boolean;
};

/**
 * Discover every installed instance of each agent (all `PATH` matches +
 * fallbacks + override that pass the probe), grouped per strategy. Groups with
 * no passing instance are omitted unless `includeRejectedCandidates` is true
 * and a detected candidate failed a probe.
 */
export async function discoverLocalAcpAgentInstances(
  options: LocalAcpDiscoveryOptions = {}
): Promise<DiscoveredAcpAgentGroup[]> {
  const strategies = options.strategies ?? BUILT_IN_ACP_STRATEGIES;
  const env = options.env ?? process.env;
  const probe = options.probe ?? makeDefaultProbe(env);
  const listExecutables = options.listExecutables ?? defaultListExecutables;
  const now = options.now ?? Date.now;
  const groups = await Promise.all(
    strategies.map((strategy) =>
      discoverStrategyInstances(
        strategy,
        probe,
        now,
        env,
        listExecutables,
        options.overrides?.[strategy.id],
        options.includeRejectedCandidates === true
      )
    )
  );
  return groups.filter((group): group is DiscoveredAcpAgentGroup => group !== undefined);
}

/**
 * First-match-per-agent discovery (legacy view). Returns at most one record per
 * agent — the first instance that passed the probe in candidate order.
 */
export async function discoverLocalAcpAgents(
  options: LocalAcpDiscoveryOptions = {}
): Promise<DiscoveredAcpAgent[]> {
  const groups = await discoverLocalAcpAgentInstances(options);
  return groups.flatMap((group) => {
    const first = group.instances[0];
    if (first === undefined) return [];
    const agent: DiscoveredAcpAgent = {
      strategyId: group.strategyId,
      backendId: group.backendId,
      name: group.name,
      command: first.command,
      args: group.args,
      env: group.env,
      discoveredAt: group.discoveredAt
    };
    if (first.version !== undefined) agent.version = first.version;
    return [agent];
  });
}

async function discoverStrategyInstances(
  strategy: Strategy,
  probe: LocalAcpAgentProbe,
  now: () => number,
  env: NodeJS.ProcessEnv,
  listExecutables: AcpPathExecutableLister,
  override?: string,
  includeRejectedCandidates = false
): Promise<DiscoveredAcpAgentGroup | undefined> {
  const candidates = candidateCommands(strategy, env, listExecutables, override);
  const instances: DiscoveredAcpAgentInstance[] = [];
  const rejectedInstances: RejectedAcpAgentInstance[] = [];
  for (const candidate of candidates) {
    const [versionResult, helpResult] = await Promise.all([
      runProbe(probe, candidate.command, strategy.discoveryProbe.versionArgs),
      runProbe(probe, candidate.command, strategy.discoveryProbe.helpArgs)
    ]);
    const version = versionResult ? parseCliVersion(resultText(versionResult)) : undefined;
    if (!versionResult || !helpResult) {
      if (includeRejectedCandidates && candidate.detected) {
        const rejected: RejectedAcpAgentInstance = {
          command: candidate.command,
          source: candidate.source,
          reason: versionResult ? "acp-probe-failed" : "version-probe-failed"
        };
        if (version !== undefined) rejected.version = version;
        rejectedInstances.push(rejected);
      }
      continue;
    }
    // A strategy with no `helpMatches` relies on the EXIT CODE: the help probe
    // succeeding (enforced just above — a non-zero exit makes `runProbe` return
    // undefined) is itself the ACP-capability signal. Only when a regex is set
    // do we additionally parse the (drift-prone) help text.
    if (
      strategy.discoveryProbe.helpMatches !== undefined &&
      !strategy.discoveryProbe.helpMatches.test(resultText(helpResult))
    ) {
      if (includeRejectedCandidates && candidate.detected) {
        const rejected: RejectedAcpAgentInstance = {
          command: candidate.command,
          source: candidate.source,
          reason: "acp-help-mismatch"
        };
        if (version !== undefined) rejected.version = version;
        rejectedInstances.push(rejected);
      }
      continue;
    }
    const instance: DiscoveredAcpAgentInstance = {
      command: candidate.command,
      source: candidate.source
    };
    if (version !== undefined) instance.version = version;
    instances.push(instance);
  }
  if (instances.length === 0 && rejectedInstances.length === 0) {
    return undefined;
  }
  return {
    strategyId: strategy.id,
    backendId: strategy.backendId,
    name: strategy.displayName,
    args: ensureArgs(strategy.spawn.args, strategy.spawn.ensureArgs),
    env: strategy.spawn.env ?? {},
    instances,
    ...(rejectedInstances.length > 0 ? { rejectedInstances } : {}),
    discoveredAt: now()
  };
}

type Candidate = {
  command: string;
  source: AcpAgentInstanceSource;
  /** True only when command enumeration found a concrete executable path. */
  detected: boolean;
};

/** Build the de-duplicated candidate list for a strategy: override first, then
 *  every `PATH` match of the bare command (or the bare command itself when the
 *  lister finds none, so `execFile`'s own `PATH` resolution still gets a shot),
 *  then the strategy's fallback paths. Duplicates (by resolved real path) are
 *  collapsed so the same physical binary isn't listed twice. */
function candidateCommands(
  strategy: Strategy,
  env: NodeJS.ProcessEnv,
  listExecutables: AcpPathExecutableLister,
  override?: string
): Candidate[] {
  const out: Candidate[] = [];
  const seen = new Set<string>();
  const push = (
    command: string,
    source: AcpAgentInstanceSource,
    detected: boolean
  ): void => {
    const trimmed = command.trim();
    if (trimmed.length === 0) return;
    const key = canonicalize(trimmed);
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ command: trimmed, source, detected });
  };

  if (override && override.trim().length > 0) {
    push(override, "override", isExecutableFile(override));
  }
  const pathMatches = listExecutables(strategy.discoveryProbe.command, env);
  if (pathMatches.length > 0) {
    for (const match of pathMatches) push(match, "path", true);
  } else {
    // No PATH hit (or an injected no-op lister): keep the bare command so
    // `execFile` resolves it via its own PATH and scripted-probe tests match.
    push(strategy.discoveryProbe.command, "path", false);
  }
  for (const fallback of strategy.discoveryProbe.fallbackCommands ?? []) {
    push(fallback, "fallback", isExecutableFile(fallback));
  }
  return out;
}

function isExecutableFile(command: string): boolean {
  try {
    const stat = statSync(command);
    return stat.isFile() && (process.platform === "win32" || (stat.mode & 0o111) !== 0);
  } catch {
    return false;
  }
}

/** Resolve symlinks so the same binary reached via two PATH entries dedupes. */
function canonicalize(command: string): string {
  if (!path.isAbsolute(command)) {
    return process.platform === "win32" ? command.toLowerCase() : command;
  }
  try {
    const canonical = realpathSync(command);
    return process.platform === "win32" ? canonical.toLowerCase() : canonical;
  } catch {
    return process.platform === "win32" ? command.toLowerCase() : command;
  }
}

/** Default executable lister: scan `env.PATH` AND well-known version-manager /
 *  install dirs for an executable file named `command`. On Windows, expand
 *  each PATH entry using PATHEXT and return the actual .COM/.EXE/.BAT/.CMD
 *  candidates rather than a bare command that `execFile` cannot launch.
 *
 *  Scanning beyond `PATH` is deliberate: a desktop app launched from Finder /
 *  Dock inherits launchd's minimal `PATH`, and login-shell hydration can't
 *  reliably recover a version-manager `PATH` (nvm is often lazy-loaded and
 *  pins a different node version than the one the agent CLI is installed
 *  under). So an `npm i -g qwen` under nvm would be invisible. We find it by
 *  scanning the version-manager bin dirs directly. */
function defaultListExecutables(command: string, env: NodeJS.ProcessEnv): string[] {
  // A bare command name only — never enumerate when a path was passed.
  if (command.includes("/") || command.includes("\\")) return [];
  const found: string[] = [];
  const seenDir = new Set<string>();
  for (const dir of discoveryDirs(env)) {
    const normalizedDir = normalizePathEntry(dir);
    const dirKey = process.platform === "win32" ? normalizedDir.toLowerCase() : normalizedDir;
    if (normalizedDir.length === 0 || seenDir.has(dirKey)) continue;
    seenDir.add(dirKey);
    for (const commandName of executableCommandNames(command, env)) {
      const candidate = path.join(normalizedDir, commandName);
      try {
        const stat = statSync(candidate);
        if (stat.isFile() && (process.platform === "win32" || (stat.mode & 0o111) !== 0)) {
          found.push(candidate);
        }
      } catch {
        // Not in this dir; keep scanning.
      }
    }
  }
  return found;
}

function executableCommandNames(command: string, env: NodeJS.ProcessEnv): string[] {
  if (process.platform !== "win32") return [command];
  const extensions = (readWindowsEnv(env, "PATHEXT")?.trim() || ".COM;.EXE;.BAT;.CMD")
    .split(";")
    .map((extension) => extension.trim())
    .filter(Boolean)
    .map((extension) => extension.startsWith(".") ? extension : `.${extension}`);
  const commandExtension = path.win32.extname(command);
  if (
    commandExtension.length > 0 &&
    extensions.some((extension) => extension.toLowerCase() === commandExtension.toLowerCase())
  ) {
    return [command];
  }
  return extensions.map((extension) => `${command}${extension}`);
}

function readWindowsEnv(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const key = Object.keys(env).find((candidate) => candidate.toLowerCase() === name.toLowerCase());
  return key ? env[key] : undefined;
}

function normalizePathEntry(entry: string): string {
  const trimmed = entry.trim();
  const quoted = trimmed.match(/^"(.*)"$/);
  return quoted?.[1] ?? trimmed;
}

/** Dirs to scan for agent executables: every `env.PATH` entry first, then the
 *  well-known version-manager / package-manager bin dirs a GUI app's `PATH`
 *  usually omits. */
function discoveryDirs(env: NodeJS.ProcessEnv): string[] {
  const pathValue = process.platform === "win32"
    ? readWindowsEnv(env, "PATH") ?? ""
    : env.PATH ?? "";
  const pathDirs = pathValue.split(path.delimiter);
  return process.platform === "win32"
    ? pathDirs
    : [...pathDirs, ...wellKnownAgentBinDirs(homedir())];
}

/** Well-known bin dirs where a CLI installed via a node/JS version manager or
 *  a per-user package manager lives — even when it isn't on a GUI app's `PATH`.
 *  Exported for testing; `home` defaults to the user's home dir. */
export function wellKnownAgentBinDirs(home: string = homedir()): string[] {
  return [
    // Every installed nvm node version's bin (the agent may be under any one).
    ...nvmNodeBinDirs(home),
    // Other version / package managers.
    path.join(home, ".volta", "bin"),
    path.join(home, ".bun", "bin"),
    path.join(home, ".asdf", "shims"),
    path.join(home, ".deno", "bin"),
    path.join(home, ".local", "bin"),
    path.join(home, ".npm-global", "bin"),
    // Common system install prefixes.
    "/opt/homebrew/bin",
    "/usr/local/bin"
  ];
}

/** Every `~/.nvm/versions/node/<v>/bin` dir, newest-first so the most recent
 *  node version's install is tried before older ones. Empty when nvm absent. */
function nvmNodeBinDirs(home: string): string[] {
  const base = path.join(home, ".nvm", "versions", "node");
  try {
    return readdirSync(base)
      .sort()
      .reverse()
      .map((version) => path.join(base, version, "bin"));
  } catch {
    return [];
  }
}

function ensureArgs(args: string[], ensure: string[] | undefined): string[] {
  if (!ensure || ensure.length === 0) {
    return args;
  }
  const result = [...args];
  for (const arg of ensure) {
    if (!result.includes(arg)) result.push(arg);
  }
  return result;
}

function makeDefaultProbe(env: NodeJS.ProcessEnv): LocalAcpAgentProbe {
  return async (command: string, args: string[]): Promise<LocalAcpProbeResult> => {
    const launchEnv = prependCommandDirToPath(command, env);
    const invocation = createCommandInvocation({ command, args, env: launchEnv });
    return await execFile(invocation.command, invocation.args, {
      timeout: 5_000,
      maxBuffer: 1024 * 1024,
      // Prepend the candidate's own dir so a node-script CLI (e.g. an nvm-
      // installed `qwen`) finds its sibling `node` during the probe.
      env: launchEnv,
      windowsVerbatimArguments: invocation.windowsVerbatimArguments
    });
  };
}

async function runProbe(
  probe: LocalAcpAgentProbe,
  command: string,
  args: string[]
): Promise<LocalAcpProbeResult | undefined> {
  try {
    return await probe(command, args);
  } catch {
    return undefined;
  }
}

function resultText(result: LocalAcpProbeResult): string {
  return [result.stdout, result.stderr]
    .flatMap((value) => (value === undefined ? [] : [value]))
    .map((value) => (Buffer.isBuffer(value) ? value.toString("utf8") : value))
    .join("\n");
}

function parseCliVersion(output: string): string | undefined {
  const trimmed = output.trim();
  if (!trimmed) {
    return undefined;
  }
  return trimmed.match(/\d+\.\d+\.\d+(?:[-+][\w.-]+)?/)?.[0] ?? trimmed;
}
