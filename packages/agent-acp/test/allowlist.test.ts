import { describe, expect, it } from "vitest";
import {
  AcpAgentAllowlist,
  isBannedAcpRegistryId
} from "../src/discovery/acp-agent-allowlist";
import { AcpRegistryService } from "../src/discovery/acp-registry-service";
import type { AcpRegistryAgent } from "../src/discovery/acp-registry-types";

function agent(overrides: Partial<AcpRegistryAgent>): AcpRegistryAgent {
  return {
    id: "example",
    backendId: "acp:example",
    name: "Example",
    authors: [],
    distributions: [],
    distributionKinds: [],
    auth: { required: false, methods: [] },
    raw: {},
    ...overrides
  };
}

describe("AcpAgentAllowlist", () => {
  it("rejects the banned codex-acp registry id from the ACP path", () => {
    expect(isBannedAcpRegistryId("codex-acp")).toBe(true);
    const allowlist = new AcpAgentAllowlist([{ id: "any", registryId: "codex-acp" }]);
    expect(allowlist.evaluate(agent({ id: "codex-acp" }))).toEqual({
      allowed: false,
      reason: "banned"
    });
  });

  it("rejects a GPL-family license", () => {
    const allowlist = new AcpAgentAllowlist([
      {
        id: "example-npx",
        registryId: "example",
        distributionKinds: ["npx"],
        allowedPackageNames: ["@example/agent"]
      }
    ]);
    const gpl = agent({
      license: "GPL-3.0",
      distributions: [{ kind: "npx", packageName: "@example/agent", args: [], env: {} }],
      distributionKinds: ["npx"]
    });
    // A GPL-family agent is rejected even though its package name is pinned.
    expect(allowlist.evaluate(gpl)).toMatchObject({ allowed: false });
    const distribution = gpl.distributions[0]!;
    expect(allowlist.evaluateDistribution(gpl, distribution)).toMatchObject({
      allowed: false
    });
    // The pinned package alone (non-GPL agent) is accepted, proving the GPL
    // license — not the package pinning — is what blocked it above.
    const mit = agent({
      license: "MIT",
      distributions: [{ kind: "npx", packageName: "@example/agent", args: [], env: {} }],
      distributionKinds: ["npx"]
    });
    expect(allowlist.evaluate(mit)).toMatchObject({ allowed: true });
  });

  it("rejects an unpinned npx package but accepts a pinned one", () => {
    const allowlist = new AcpAgentAllowlist([
      {
        id: "example-npx",
        registryId: "example",
        distributionKinds: ["npx"],
        allowedPackageNames: ["@example/agent"]
      }
    ]);
    const unpinned = allowlist.evaluateDistribution(agent({}), {
      kind: "npx",
      packageName: "@evil/agent",
      args: [],
      env: {}
    });
    expect(unpinned).toEqual({ allowed: false, reason: "allowlist-rule-mismatch" });

    const pinned = allowlist.evaluateDistribution(agent({}), {
      kind: "npx",
      packageName: "@example/agent",
      args: [],
      env: {}
    });
    expect(pinned).toMatchObject({ allowed: true, ruleId: "example-npx" });
  });

  it("rejects an unpinned binary archive host and accepts a pinned one", () => {
    const allowlist = new AcpAgentAllowlist([
      {
        id: "example-binary",
        registryId: "example",
        distributionKinds: ["binary"],
        allowedArchiveHosts: ["github.com"],
        allowUnverifiedBinary: true
      }
    ]);
    const wrongHost = allowlist.evaluateDistribution(agent({}), {
      kind: "binary",
      platform: "darwin-arm64",
      archiveUrl: "https://evil.example.com/agent.tar.gz",
      command: "agent",
      args: [],
      env: {}
    });
    expect(wrongHost).toEqual({ allowed: false, reason: "allowlist-rule-mismatch" });

    const okHost = allowlist.evaluateDistribution(agent({}), {
      kind: "binary",
      platform: "darwin-arm64",
      archiveUrl: "https://github.com/example/agent/releases/agent.tar.gz",
      command: "agent",
      args: [],
      env: {}
    });
    expect(okHost).toMatchObject({ allowed: true });
  });

  it("rejects an agent that isn't allowlisted at all", () => {
    const allowlist = new AcpAgentAllowlist([]);
    expect(allowlist.evaluate(agent({ id: "stranger" }))).toEqual({
      allowed: false,
      reason: "not-allowlisted"
    });
  });
});

describe("AcpRegistryService — normalize + policy", () => {
  it("fetches, normalizes, and applies the allowlist policy", async () => {
    const allowlist = new AcpAgentAllowlist([
      {
        id: "example-npx",
        registryId: "example",
        distributionKinds: ["npx"],
        allowedPackageNames: ["@example/agent"]
      }
    ]);
    const service = new AcpRegistryService({
      allowlist,
      now: () => 7,
      registryUrl: "https://example/registry.json",
      fetch: async () => ({
        ok: true,
        status: 200,
        statusText: "OK",
        json: async () => ({
          agents: [
            {
              id: "example",
              name: "Example",
              version: "1.0.0",
              authors: ["Example Inc"],
              distribution: { npx: { package: "@example/agent", args: [] } },
              auth: { required: false, methods: ["agent-managed"] }
            },
            {
              id: "codex-acp",
              name: "Codex ACP",
              distribution: { npx: { package: "codex-acp", args: [] } }
            }
          ]
        })
      })
    });

    const snapshot = await service.fetchRegistry();
    expect(snapshot.fetchedAt).toBe(7);
    expect(snapshot.agents.map((a) => a.id)).toEqual(["example", "codex-acp"]);

    const policied = service.applyAllowlist(snapshot);
    const example = policied.find((a) => a.id === "example")!;
    expect(example.installable).toBe(true);
    expect(example.allowlist).toMatchObject({ allowed: true });

    const codex = policied.find((a) => a.id === "codex-acp")!;
    expect(codex.installable).toBe(false);
    expect(codex.allowlist).toEqual({ allowed: false, reason: "banned" });
  });
});
