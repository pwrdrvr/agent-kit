// Registry types for the ACP extension path. The four built-in strategies do
// NOT require the registry; this is how a host adds more ACP agents from the
// public Agent Client Protocol registry, gated by the allowlist.
//
// Ported from PwrAgnt acp-registry-types.ts, with @pwragent/shared types
// inlined as neutral local types.

import { buildAcpBackendId } from "../strategies/strategy-types";

export const ACP_REGISTRY_URL =
  "https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json";

export type AcpDistributionKind = "npx" | "uvx" | "binary" | "local";

export type AcpRegistryDistributionEnv = Record<string, string>;

export type AcpPackageDistribution = {
  kind: "npx" | "uvx";
  packageName: string;
  args: string[];
  env: AcpRegistryDistributionEnv;
};

export type AcpBinaryPlatformDistribution = {
  kind: "binary";
  platform: string;
  archiveUrl: string;
  command: string;
  args: string[];
  env: AcpRegistryDistributionEnv;
  checksum?: string;
  signatureUrl?: string;
};

export type AcpRegistryDistribution =
  | AcpPackageDistribution
  | AcpBinaryPlatformDistribution;

export type AcpRegistryAuthMethod = "agent-managed" | "terminal" | "unknown";

export type AcpRegistryAuthDescriptor = {
  required: boolean;
  methods: AcpRegistryAuthMethod[];
  raw?: unknown;
};

export type AcpRegistryAgent = {
  id: string;
  backendId: string;
  name: string;
  version?: string;
  description?: string;
  authors: string[];
  license?: string;
  repositoryUrl?: string;
  websiteUrl?: string;
  iconUrl?: string;
  distributions: AcpRegistryDistribution[];
  distributionKinds: AcpDistributionKind[];
  auth: AcpRegistryAuthDescriptor;
  raw: unknown;
};

export type AcpVerificationStatus =
  | "verified"
  | "unverified-allowed"
  | "unverified-blocked"
  | "not-applicable";

export type AcpAllowlistDecision =
  | { allowed: true; ruleId: string; unverifiedBinaryAllowed: boolean }
  | { allowed: false; reason: string };

export type AcpRegistryAgentWithPolicy = AcpRegistryAgent & {
  allowlist: AcpAllowlistDecision;
  installable: boolean;
  unavailableReason?: string;
  verificationStatus: AcpVerificationStatus;
};

export type AcpRegistrySnapshot = {
  fetchedAt: number;
  agents: AcpRegistryAgent[];
  raw: unknown;
};

export { buildAcpBackendId };
