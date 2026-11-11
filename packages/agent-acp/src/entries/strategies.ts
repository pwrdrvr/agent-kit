// `@pwrdrvr/agent-acp/strategies`: the built-in agent strategies and their
// types. Nothing here imports `@agentclientprotocol/sdk`, so a host can read
// the strategy table at start without loading the SDK. The SDK-free test in
// test/subpath-entries.test.ts holds every entry under entries/ to that.

export {
  type AcpAgentStrategy,
  type AcpAgentQuirks,
  type AcpDiscoveryProbe,
  type AcpSpawnSpec,
  type LocalAcpAgentProbe,
  type LocalAcpProbeOptions,
  type LocalAcpProbeResult,
  buildAcpBackendId,
  defaultQuirks
} from "../strategies/strategy-types";

export {
  BUILT_IN_ACP_STRATEGIES,
  buildStrategyTable,
  strategyById,
  strategyByBackendId,
  geminiStrategy,
  grokStrategy,
  kimiStrategy,
  qwenStrategy
} from "../strategies/index";
