// Per-agent quirks live in a registered strategy table, never as inline
// `if (agentId === ...)` branches in the normalizer or client (KTD-A2). Adding a
// 5th ACP agent is a new table entry — zero normalizer edits.
//
// A strategy carries three things:
//   • discovery   — how to probe whether the CLI is installed + ACP-capable;
//   • spawn       — the command + args that launch it in ACP stdio mode;
//   • quirks      — normalization behavior toggles the normalizer READS
//                   (e.g. whether agent "thought" chunks surface as messages,
//                   where the thread title comes from).

export type LocalAcpProbeResult = {
  stdout?: string | Buffer;
  stderr?: string | Buffer;
};

export type LocalAcpAgentProbe = (
  command: string,
  args: string[]
) => Promise<LocalAcpProbeResult>;

/** How a strategy decides it is installed + ACP-capable on this machine. */
export type AcpDiscoveryProbe = {
  /** Args that print a version (probed first; failure = not installed). */
  versionArgs: string[];
  /** Args that print help/usage text the `helpMatches` regex confirms ACP support against. */
  helpArgs: string[];
  /** Regex the help/usage output must match for the agent to count as ACP-capable. */
  helpMatches: RegExp;
  /** Bare command name tried first. */
  command: string;
  /** Additional candidate command paths (Homebrew prefixes, `~/.<agent>/bin`, …). */
  fallbackCommands?: string[];
};

/** Launch invocation: how to spawn the CLI in ACP stdio server mode. */
export type AcpSpawnSpec = {
  /** Command to run (resolved against the discovered candidate at spawn time). */
  command: string;
  /** Args that put the CLI into ACP stdio server mode (e.g. `["--acp"]`). */
  args: string[];
  /** Extra env to set when launching (e.g. Gemini workspace-trust). */
  env?: Record<string, string>;
  /** Extra args appended only when missing (e.g. Gemini `--skip-trust`). */
  ensureArgs?: string[];
};

/**
 * Normalization quirks the normalizer reads. NO agent-id literal ever appears
 * in the normalizer — it reads these fields off the strategy it was constructed
 * with. A synthetic strategy with different quirk values flows through the
 * normalizer with zero normalizer changes (asserted in tests).
 */
export type AcpAgentQuirks = {
  /**
   * Whether agent "thought"/reasoning chunks surface as assistant messages.
   * Qwen sets this false (its thoughts are noisy scaffolding); others true.
   */
  surfaceThoughts: boolean;
  /**
   * Where the auto-generated thread title comes from:
   *   • "topic-update"  — a `tool_call` titled `Update topic to: "…"` (Gemini/Kimi/Qwen);
   *   • "session-summary" — a vendor `session_summary_generated` update (Grok);
   *   • "both" — recognize either.
   */
  titleFrom: "topic-update" | "session-summary" | "both";
  /** Vendor notification methods routed through the same session/update path. */
  vendorNotificationMethods?: string[];
};

export type AcpAgentStrategy = {
  /** Strategy id, also the registry id (`gemini`, `grok`, `kimi`, `qwen`, …). */
  id: string;
  /** Neutral backend id (`acp:<id>`) used as the thread/session correlation key. */
  backendId: string;
  displayName: string;
  authors: string[];
  license?: string;
  repositoryUrl?: string;
  discoveryProbe: AcpDiscoveryProbe;
  spawn: AcpSpawnSpec;
  quirks: AcpAgentQuirks;
};

/** Build the neutral backend id for a registry id. */
export function buildAcpBackendId(registryId: string): string {
  return `acp:${registryId}`;
}

const DEFAULT_QUIRKS: AcpAgentQuirks = {
  surfaceThoughts: true,
  titleFrom: "topic-update"
};

/** Quirks for an unknown/synthetic strategy default to the common case. */
export function defaultQuirks(overrides: Partial<AcpAgentQuirks> = {}): AcpAgentQuirks {
  return { ...DEFAULT_QUIRKS, ...overrides };
}
