// Fetch + normalize the public ACP registry and apply the allowlist policy.
// The EXTENSION path for adding ACP agents beyond the four built-in strategies.
//
// Ported from PwrAgnt acp-registry-service.ts, with @pwragent/shared dropped.

import {
  ACP_REGISTRY_URL,
  buildAcpBackendId,
  type AcpAllowlistDecision,
  type AcpBinaryPlatformDistribution,
  type AcpPackageDistribution,
  type AcpRegistryAgent,
  type AcpRegistryAgentWithPolicy,
  type AcpRegistryAuthDescriptor,
  type AcpRegistryDistribution,
  type AcpRegistrySnapshot,
  type AcpVerificationStatus
} from "./acp-registry-types";
import {
  AcpAgentAllowlist,
  defaultAcpAgentAllowlist
} from "./acp-agent-allowlist";

export type AcpRegistryFetch = (
  input: string,
  init?: { headers?: Record<string, string> }
) => Promise<{
  ok: boolean;
  status: number;
  statusText: string;
  json(): Promise<unknown>;
}>;

export type AcpRegistryServiceOptions = {
  allowlist?: AcpAgentAllowlist;
  fetch?: AcpRegistryFetch;
  now?: () => number;
  registryUrl?: string;
};

export type AcpDistributionPolicy = {
  allowlist: AcpAllowlistDecision;
  installable: boolean;
  verificationStatus: AcpVerificationStatus;
  unavailableReason?: string;
};

export class AcpRegistryService {
  private readonly allowlist: AcpAgentAllowlist;
  private readonly fetcher: AcpRegistryFetch;
  private readonly now: () => number;
  private readonly registryUrl: string;

  constructor(options: AcpRegistryServiceOptions = {}) {
    this.allowlist = options.allowlist ?? defaultAcpAgentAllowlist;
    this.fetcher =
      options.fetch ??
      (async (input, init) => {
        const response = await globalThis.fetch(input, init);
        return {
          ok: response.ok,
          status: response.status,
          statusText: response.statusText,
          json: () => response.json() as Promise<unknown>
        };
      });
    this.now = options.now ?? Date.now;
    this.registryUrl = options.registryUrl ?? ACP_REGISTRY_URL;
  }

  async fetchRegistry(): Promise<AcpRegistrySnapshot> {
    const response = await this.fetcher(this.registryUrl, {
      headers: { accept: "application/json" }
    });
    if (!response.ok) {
      throw new Error(
        `ACP registry request failed: ${response.status} ${response.statusText}`
      );
    }
    const raw = await response.json();
    return { fetchedAt: this.now(), agents: normalizeRegistry(raw), raw };
  }

  applyAllowlist(snapshot: AcpRegistrySnapshot): AcpRegistryAgentWithPolicy[] {
    return snapshot.agents.map((agent) => {
      const allowlist = this.allowlist.evaluate(agent);
      const distributionPolicies = agent.distributions.map((distribution) =>
        this.evaluateDistribution(agent, distribution)
      );
      const installablePolicy = distributionPolicies.find((policy) => policy.installable);
      const firstBlockedAllowedPolicy = distributionPolicies.find(
        (policy) => policy.allowlist.allowed
      );
      const installable = Boolean(installablePolicy);
      const result: AcpRegistryAgentWithPolicy = {
        ...agent,
        allowlist,
        installable,
        verificationStatus:
          installablePolicy?.verificationStatus ??
          firstBlockedAllowedPolicy?.verificationStatus ??
          "not-applicable"
      };
      const unavailableReason = installable
        ? undefined
        : (firstBlockedAllowedPolicy?.unavailableReason ??
          (allowlist.allowed ? "distribution-not-installable" : allowlist.reason));
      if (unavailableReason !== undefined) result.unavailableReason = unavailableReason;
      return result;
    });
  }

  evaluateDistribution(
    agent: AcpRegistryAgent,
    distribution: AcpRegistryDistribution
  ): AcpDistributionPolicy {
    const allowlist = this.allowlist.evaluateDistribution(agent, distribution);
    return evaluateAcpDistributionPolicy(distribution, allowlist);
  }
}

export function evaluateAcpDistributionPolicy(
  distribution: AcpRegistryDistribution,
  allowlist: AcpAllowlistDecision
): AcpDistributionPolicy {
  if (!allowlist.allowed) {
    return {
      allowlist,
      installable: false,
      verificationStatus: "not-applicable",
      unavailableReason: allowlist.reason
    };
  }
  if (distribution.kind !== "binary") {
    return { allowlist, installable: true, verificationStatus: "not-applicable" };
  }
  if (distribution.checksum) {
    return { allowlist, installable: true, verificationStatus: "verified" };
  }
  return {
    allowlist,
    installable: allowlist.unverifiedBinaryAllowed,
    verificationStatus: allowlist.unverifiedBinaryAllowed
      ? "unverified-allowed"
      : "unverified-blocked",
    ...(allowlist.unverifiedBinaryAllowed
      ? {}
      : { unavailableReason: "binary-integrity-metadata-missing" })
  };
}

export function normalizeRegistry(raw: unknown): AcpRegistryAgent[] {
  const record = asRecord(raw);
  const rawAgents = Array.isArray(record?.agents) ? record.agents : [];
  return rawAgents.flatMap((item) => {
    const agent = normalizeAgent(item);
    return agent ? [agent] : [];
  });
}

function normalizeAgent(raw: unknown): AcpRegistryAgent | undefined {
  const record = asRecord(raw);
  if (!record || typeof record.id !== "string" || typeof record.name !== "string") {
    return undefined;
  }
  const distributions = normalizeDistributions(record.distribution);
  if (distributions.length === 0) {
    return undefined;
  }
  const agent: AcpRegistryAgent = {
    id: record.id,
    backendId: buildAcpBackendId(record.id),
    name: record.name,
    authors: Array.isArray(record.authors)
      ? record.authors.filter((author): author is string => typeof author === "string")
      : [],
    distributions,
    distributionKinds: [...new Set(distributions.map((d) => d.kind))],
    auth: normalizeAuth(record.auth),
    raw
  };
  const version = stringValue(record.version);
  if (version !== undefined) agent.version = version;
  const description = stringValue(record.description);
  if (description !== undefined) agent.description = description;
  const license = stringValue(record.license);
  if (license !== undefined) agent.license = license;
  const repositoryUrl = stringValue(record.repository);
  if (repositoryUrl !== undefined) agent.repositoryUrl = repositoryUrl;
  const websiteUrl = stringValue(record.website);
  if (websiteUrl !== undefined) agent.websiteUrl = websiteUrl;
  const iconUrl = stringValue(record.icon);
  if (iconUrl !== undefined) agent.iconUrl = iconUrl;
  return agent;
}

function normalizeDistributions(raw: unknown): AcpRegistryDistribution[] {
  const record = asRecord(raw);
  if (!record) {
    return [];
  }
  const distributions: AcpRegistryDistribution[] = [];
  const npx = normalizePackageDistribution("npx", record.npx);
  if (npx) distributions.push(npx);
  const uvx = normalizePackageDistribution("uvx", record.uvx);
  if (uvx) distributions.push(uvx);
  const binaryRecord = asRecord(record.binary);
  if (binaryRecord) {
    for (const [platform, value] of Object.entries(binaryRecord)) {
      const binary = normalizeBinaryDistribution(platform, value);
      if (binary) distributions.push(binary);
    }
  }
  return distributions;
}

function normalizePackageDistribution(
  kind: "npx" | "uvx",
  raw: unknown
): AcpPackageDistribution | undefined {
  const record = asRecord(raw);
  if (!record || typeof record.package !== "string") {
    return undefined;
  }
  return {
    kind,
    packageName: record.package,
    args: stringArray(record.args),
    env: stringRecord(record.env)
  };
}

function normalizeBinaryDistribution(
  platform: string,
  raw: unknown
): AcpBinaryPlatformDistribution | undefined {
  const record = asRecord(raw);
  if (!record || typeof record.archive !== "string" || typeof record.cmd !== "string") {
    return undefined;
  }
  const distribution: AcpBinaryPlatformDistribution = {
    kind: "binary",
    platform,
    archiveUrl: record.archive,
    command: record.cmd,
    args: stringArray(record.args),
    env: stringRecord(record.env)
  };
  const checksum = stringValue(record.checksum) ?? stringValue(record.sha256);
  if (checksum !== undefined) distribution.checksum = checksum;
  const signatureUrl = stringValue(record.signature) ?? stringValue(record.signatureUrl);
  if (signatureUrl !== undefined) distribution.signatureUrl = signatureUrl;
  return distribution;
}

function normalizeAuth(raw: unknown): AcpRegistryAuthDescriptor {
  if (!raw) {
    return { required: false, methods: [] };
  }
  const record = asRecord(raw);
  if (!record) {
    return { required: true, methods: ["unknown"], raw };
  }
  const methods = stringArray(record.methods).map((method) =>
    method === "agent-managed" || method === "terminal" ? method : "unknown"
  );
  return {
    required: record.required === false ? false : true,
    methods: methods.length > 0 ? [...new Set(methods)] : ["unknown"],
    raw
  };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function stringRecord(value: unknown): Record<string, string> {
  const record = asRecord(value);
  if (!record) {
    return {};
  }
  return Object.fromEntries(
    Object.entries(record).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string"
    )
  );
}
