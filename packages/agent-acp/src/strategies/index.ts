// The strategy table. The four built-ins do not require the registry — the
// registry (discovery/acp-registry.ts) is the EXTENSION path. Adding a 5th
// agent is a new entry here, with zero normalizer/client edits.

import type { AcpAgentStrategy } from "./strategy-types";
import { geminiStrategy } from "./gemini";
import { grokStrategy } from "./grok";
import { kimiStrategy } from "./kimi";
import { qwenStrategy } from "./qwen";

export { geminiStrategy } from "./gemini";
export { grokStrategy } from "./grok";
export { kimiStrategy } from "./kimi";
export { qwenStrategy } from "./qwen";

export const BUILT_IN_ACP_STRATEGIES: readonly AcpAgentStrategy[] = [
  geminiStrategy,
  kimiStrategy,
  grokStrategy,
  qwenStrategy
];

/** Index a list of strategies by id (built-ins by default). */
export function buildStrategyTable(
  strategies: readonly AcpAgentStrategy[] = BUILT_IN_ACP_STRATEGIES
): Map<string, AcpAgentStrategy> {
  const table = new Map<string, AcpAgentStrategy>();
  for (const strategy of strategies) {
    table.set(strategy.id, strategy);
  }
  return table;
}

/** Look up a strategy by its registry id, falling back to the built-in table. */
export function strategyById(
  id: string,
  table: Map<string, AcpAgentStrategy> = buildStrategyTable()
): AcpAgentStrategy | undefined {
  return table.get(id);
}

/** Look up a strategy by its neutral backend id (`acp:<id>`). */
export function strategyByBackendId(
  backendId: string,
  strategies: readonly AcpAgentStrategy[] = BUILT_IN_ACP_STRATEGIES
): AcpAgentStrategy | undefined {
  return strategies.find((strategy) => strategy.backendId === backendId);
}
