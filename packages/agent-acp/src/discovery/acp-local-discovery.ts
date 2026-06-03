// Probe which ACP CLIs are installed locally. STRATEGY-DRIVEN: iterates the
// strategy table and runs each strategy's `discoveryProbe`. Adding a 5th agent
// (a new strategy entry) surfaces it through discovery with ZERO changes here.
//
// Ported from PwrAgnt acp-local-discovery.ts, generalized so the per-agent probe
// details live in the strategy, not inline branches.

import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { BUILT_IN_ACP_STRATEGIES } from "../strategies/index";
import type {
  AcpAgentStrategy,
  AcpAgentStrategy as Strategy,
  LocalAcpAgentProbe,
  LocalAcpProbeResult
} from "../strategies/strategy-types";

const execFile = promisify(execFileCallback);

export type { LocalAcpAgentProbe, LocalAcpProbeResult } from "../strategies/strategy-types";

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

export type LocalAcpDiscoveryOptions = {
  probe?: LocalAcpAgentProbe;
  now?: () => number;
  /** Strategy table to probe (built-ins by default). */
  strategies?: readonly AcpAgentStrategy[];
  /** Per-strategy command override (tried before the strategy's own candidates). */
  overrides?: Record<string, string>;
};

export async function discoverLocalAcpAgents(
  options: LocalAcpDiscoveryOptions = {}
): Promise<DiscoveredAcpAgent[]> {
  const strategies = options.strategies ?? BUILT_IN_ACP_STRATEGIES;
  const probe = options.probe ?? defaultProbe;
  const now = options.now ?? Date.now;
  const discovered = await Promise.all(
    strategies.map((strategy) =>
      discoverStrategy(strategy, probe, now, options.overrides?.[strategy.id])
    )
  );
  return discovered.filter((agent): agent is DiscoveredAcpAgent => agent !== undefined);
}

async function discoverStrategy(
  strategy: Strategy,
  probe: LocalAcpAgentProbe,
  now: () => number,
  override?: string
): Promise<DiscoveredAcpAgent | undefined> {
  const candidates = candidateCommands(strategy, override);
  for (const command of candidates) {
    const [versionResult, helpResult] = await Promise.all([
      runProbe(probe, command, strategy.discoveryProbe.versionArgs),
      runProbe(probe, command, strategy.discoveryProbe.helpArgs)
    ]);
    if (!versionResult || !helpResult) {
      continue;
    }
    if (!strategy.discoveryProbe.helpMatches.test(resultText(helpResult))) {
      continue;
    }
    const version = parseCliVersion(resultText(versionResult));
    const agent: DiscoveredAcpAgent = {
      strategyId: strategy.id,
      backendId: strategy.backendId,
      name: strategy.displayName,
      command,
      args: ensureArgs(strategy.spawn.args, strategy.spawn.ensureArgs),
      env: strategy.spawn.env ?? {},
      discoveredAt: now()
    };
    if (version !== undefined) agent.version = version;
    return agent;
  }
  return undefined;
}

function candidateCommands(strategy: Strategy, override?: string): string[] {
  const candidates: string[] = [];
  if (override && override.trim()) {
    candidates.push(override.trim());
  }
  candidates.push(strategy.discoveryProbe.command);
  for (const fallback of strategy.discoveryProbe.fallbackCommands ?? []) {
    candidates.push(fallback);
  }
  return [...new Set(candidates)];
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

async function defaultProbe(
  command: string,
  args: string[]
): Promise<LocalAcpProbeResult> {
  return await execFile(command, args, { timeout: 5_000, maxBuffer: 1024 * 1024 });
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
