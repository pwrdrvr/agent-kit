// `@pwrdrvr/agent-acp/discovery`: local install discovery, the agent
// allowlist, and the ACP registry. Nothing here imports
// `@agentclientprotocol/sdk` (see src/entries/strategies.ts).

export {
  DEFAULT_ACP_PROBE_TIMEOUT_MS,
  discoverLocalAcpAgents,
  discoverLocalAcpAgentInstances,
  wellKnownAgentBinDirs,
  type DiscoveredAcpAgent,
  type DiscoveredAcpAgentGroup,
  type DiscoveredAcpAgentInstance,
  type RejectedAcpAgentInstance,
  type AcpAgentInstanceSource,
  type AcpPathExecutableLister,
  type LocalAcpDiscoveryOptions
} from "../discovery/acp-local-discovery";

export {
  AcpAgentAllowlist,
  defaultAcpAgentAllowlist,
  isBannedAcpRegistryId,
  BANNED_ACP_REGISTRY_IDS,
  DEFAULT_ACP_AGENT_ALLOWLIST,
  type AcpAgentAllowlistRule
} from "../discovery/acp-agent-allowlist";

export {
  AcpRegistryService,
  normalizeRegistry,
  evaluateAcpDistributionPolicy,
  type AcpRegistryFetch,
  type AcpRegistryServiceOptions,
  type AcpDistributionPolicy
} from "../discovery/acp-registry-service";

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
} from "../discovery/acp-registry-types";
