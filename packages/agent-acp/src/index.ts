// @pwrdrvr/agent-acp — ACP (Agent Client Protocol) backend adapter for
// agent-kit. Speaks ACP over stdio to local Kimi/Qwen/Gemini/Grok CLIs and
// normalizes their messy `session/update` stream into agent-core's neutral
// `NormalizedThreadEvent` — the same shapes the Codex adapter emits, so a
// consumer is backend-agnostic. `AcpAgentClient` implements agent-core's
// `AgentBackend`, so it unifies with `CodexThreadClient` behind one interface.

export {
  AcpStdioJsonRpcTransport,
  type AcpJsonRpcTransport,
  type AcpStdioJsonRpcTransportOptions
} from "./acp-stdio-transport";

export {
  AcpAgentClient,
  type AcpAgentClientOptions,
  type AcpStartThreadOptions,
  type AcpStartTurnOptions,
  type AcpPromptContentBlock,
  type AcpMcpServerConfig,
  type AcpRuntimeOptionSource,
  type AcpTitleHandler,
  type AcpRuntimeCapabilitiesHandler
} from "./acp-client";

export {
  AcpSessionNormalizer,
  type AcpNormalizerOptions,
  type AcpNormalizeResult,
  type AcpApplyContext,
  readPromptText
} from "./normalizer/acp-normalizer";

export {
  toolCallFromUpdate,
  readToolCallId,
  readToolContentText
} from "./normalizer/tool-activity";

export {
  asRecord,
  readString,
  readNonEmptyString,
  readNumber,
  readBoolean,
  readFirstString,
  readKind,
  readAcpContentText,
  readContentText,
  readToolOutput,
  readFirstLocationPath,
  readUpdateText
} from "./normalizer/content";

export {
  normalizeAcpRuntimeCapabilities,
  acpRuntimeSupportsSessionLoad,
  acpSessionRuntimeStateFromCapabilities,
  acpSessionRuntimeStateFromUpdate,
  mergeAcpRuntimeState,
  modeLabelFor,
  type AcpRuntimeCapabilities,
  type AcpRuntimeCapabilitiesSource,
  type AcpRuntimeConfigOption,
  type AcpRuntimeConfigOptionValue,
  type AcpRuntimeMode,
  type AcpRuntimeModel,
  type AcpRuntimeModes,
  type AcpRuntimeModels,
  type AcpRuntimeAgentInfo,
  type AcpRuntimeAgentCapabilities,
  type AcpSessionRuntimeState
} from "./normalizer/runtime-capabilities";

export {
  type AcpAgentStrategy,
  type AcpAgentQuirks,
  type AcpDiscoveryProbe,
  type AcpSpawnSpec,
  type LocalAcpAgentProbe,
  type LocalAcpProbeResult,
  buildAcpBackendId,
  defaultQuirks
} from "./strategies/strategy-types";

export {
  BUILT_IN_ACP_STRATEGIES,
  buildStrategyTable,
  strategyById,
  strategyByBackendId,
  geminiStrategy,
  grokStrategy,
  kimiStrategy,
  qwenStrategy
} from "./strategies/index";

export {
  discoverLocalAcpAgents,
  discoverLocalAcpAgentInstances,
  type DiscoveredAcpAgent,
  type DiscoveredAcpAgentGroup,
  type DiscoveredAcpAgentInstance,
  type AcpAgentInstanceSource,
  type AcpPathExecutableLister,
  type LocalAcpDiscoveryOptions
} from "./discovery/acp-local-discovery";

export {
  AcpAgentAllowlist,
  defaultAcpAgentAllowlist,
  isBannedAcpRegistryId,
  BANNED_ACP_REGISTRY_IDS,
  DEFAULT_ACP_AGENT_ALLOWLIST,
  type AcpAgentAllowlistRule
} from "./discovery/acp-agent-allowlist";

export {
  AcpRegistryService,
  normalizeRegistry,
  evaluateAcpDistributionPolicy,
  type AcpRegistryFetch,
  type AcpRegistryServiceOptions,
  type AcpDistributionPolicy
} from "./discovery/acp-registry-service";

export {
  ACP_REGISTRY_URL,
  type AcpRegistryAgent,
  type AcpRegistryAgentWithPolicy,
  type AcpRegistryDistribution,
  type AcpPackageDistribution,
  type AcpBinaryPlatformDistribution,
  type AcpRegistryAuthDescriptor,
  type AcpRegistryAuthMethod,
  type AcpRegistrySnapshot,
  type AcpAllowlistDecision,
  type AcpDistributionKind,
  type AcpVerificationStatus
} from "./discovery/acp-registry-types";
