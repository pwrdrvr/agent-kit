// Probe which ACP CLIs are installed locally. STRATEGY-DRIVEN: iterates the
// strategy table and runs each strategy's `discoveryProbe`. Adding a 5th agent
// (a new strategy entry) surfaces it through discovery with ZERO changes here.
//
// Two granularities:
//   • `discoverLocalAcpAgentInstances` — returns EVERY installed instance of
//     each agent (each executable on `PATH` + the strategy's fallback paths +
//     an optional override that passes the probe), with its parsed version and
//     where it was found. A host UI can list them all and let the user pick.
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
import { prependCommandDirToPath } from "@pwrdrvr/agent-transport";
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
};

/**
 * Discover every installed instance of each agent (all `PATH` matches +
 * fallbacks + override that pass the probe), grouped per strategy. Groups with
 * no passing instance are omitted.
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
        options.overrides?.[strategy.id]
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
  override?: string
): Promise<DiscoveredAcpAgentGroup | undefined> {
  const candidates = candidateCommands(strategy, env, listExecutables, override);
  const instances: DiscoveredAcpAgentInstance[] = [];
  for (const candidate of candidates) {
    const [versionResult, helpResult] = await Promise.all([
      runProbe(probe, candidate.command, strategy.discoveryProbe.versionArgs),
      runProbe(probe, candidate.command, strategy.discoveryProbe.helpArgs)
    ]);
    if (!versionResult || !helpResult) {
      continue;
    }
    if (!strategy.discoveryProbe.helpMatches.test(resultText(helpResult))) {
      continue;
    }
    const version = parseCliVersion(resultText(versionResult));
    const instance: DiscoveredAcpAgentInstance = {
      command: candidate.command,
      source: candidate.source
    };
    if (version !== undefined) instance.version = version;
    instances.push(instance);
  }
  if (instances.length === 0) {
    return undefined;
  }
  return {
    strategyId: strategy.id,
    backendId: strategy.backendId,
    name: strategy.displayName,
    args: ensureArgs(strategy.spawn.args, strategy.spawn.ensureArgs),
    env: strategy.spawn.env ?? {},
    instances,
    discoveredAt: now()
  };
}

type Candidate = { command: string; source: AcpAgentInstanceSource };

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
  const push = (command: string, source: AcpAgentInstanceSource): void => {
    const trimmed = command.trim();
    if (trimmed.length === 0) return;
    const key = canonicalize(trimmed);
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ command: trimmed, source });
  };

  if (override && override.trim().length > 0) {
    push(override, "override");
  }
  const pathMatches = listExecutables(strategy.discoveryProbe.command, env);
  if (pathMatches.length > 0) {
    for (const match of pathMatches) push(match, "path");
  } else {
    // No PATH hit (or an injected no-op lister): keep the bare command so
    // `execFile` resolves it via its own PATH and scripted-probe tests match.
    push(strategy.discoveryProbe.command, "path");
  }
  for (const fallback of strategy.discoveryProbe.fallbackCommands ?? []) {
    push(fallback, "fallback");
  }
  return out;
}

/** Resolve symlinks so the same binary reached via two PATH entries dedupes. */
function canonicalize(command: string): string {
  if (!path.isAbsolute(command)) return command;
  try {
    return realpathSync(command);
  } catch {
    return command;
  }
}

/** Default executable lister: scan `env.PATH` AND well-known version-manager /
 *  install dirs for an executable file named `command`. POSIX only (Windows
 *  returns none).
 *
 *  Scanning beyond `PATH` is deliberate: a desktop app launched from Finder /
 *  Dock inherits launchd's minimal `PATH`, and login-shell hydration can't
 *  reliably recover a version-manager `PATH` (nvm is often lazy-loaded and
 *  pins a different node version than the one the agent CLI is installed
 *  under). So an `npm i -g qwen` under nvm would be invisible. We find it by
 *  scanning the version-manager bin dirs directly. */
function defaultListExecutables(command: string, env: NodeJS.ProcessEnv): string[] {
  if (process.platform === "win32") return [];
  // A bare command name only — never enumerate when a path was passed.
  if (command.includes(path.sep)) return [];
  const found: string[] = [];
  const seenDir = new Set<string>();
  for (const dir of discoveryDirs(env)) {
    if (dir.length === 0 || seenDir.has(dir)) continue;
    seenDir.add(dir);
    const candidate = path.join(dir, command);
    try {
      const stat = statSync(candidate);
      if (stat.isFile() && (stat.mode & 0o111) !== 0) {
        found.push(candidate);
      }
    } catch {
      // Not in this dir; keep scanning.
    }
  }
  return found;
}

/** Dirs to scan for agent executables: every `env.PATH` entry first, then the
 *  well-known version-manager / package-manager bin dirs a GUI app's `PATH`
 *  usually omits. */
function discoveryDirs(env: NodeJS.ProcessEnv): string[] {
  const pathValue = env.PATH ?? env.Path ?? "";
  return [...pathValue.split(path.delimiter), ...wellKnownAgentBinDirs(homedir())];
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
    return await execFile(command, args, {
      timeout: 5_000,
      maxBuffer: 1024 * 1024,
      // Prepend the candidate's own dir so a node-script CLI (e.g. an nvm-
      // installed `qwen`) finds its sibling `node` during the probe.
      env: prependCommandDirToPath(command, env)
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
