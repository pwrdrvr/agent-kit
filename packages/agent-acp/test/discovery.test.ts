import { describe, expect, it } from "vitest";
import { homedir } from "node:os";
import path from "node:path";
import type { NormalizedThreadEvent } from "@pwrdrvr/agent-core";
import {
  discoverLocalAcpAgents,
  discoverLocalAcpAgentInstances,
  type AcpPathExecutableLister,
  type LocalAcpAgentProbe
} from "../src/discovery/acp-local-discovery";
import { BUILT_IN_ACP_STRATEGIES } from "../src/strategies/index";
import {
  buildAcpBackendId,
  defaultQuirks,
  type AcpAgentStrategy
} from "../src/strategies/strategy-types";
import { AcpSessionNormalizer } from "../src/normalizer/acp-normalizer";
import { AcpAgentClient } from "../src/acp-client";
import { FakeAcpAgentTransport } from "./fake-acp-agent";

/** A probe that succeeds only for the listed (command, helpText) pairs. */
function scriptedProbe(
  installed: Record<string, { version: string; help: string }>
): LocalAcpAgentProbe {
  return async (command, args) => {
    const entry = installed[command];
    if (!entry) {
      throw new Error(`command not found: ${command}`);
    }
    if (args.includes("--version")) {
      return { stdout: entry.version };
    }
    return { stdout: entry.help };
  };
}

/** Hermetic PATH lister: never touches the real machine's PATH. Tests that
 *  want PATH matches return them explicitly via `listFrom`. */
const noPathScan: AcpPathExecutableLister = () => [];
function listFrom(table: Record<string, string[]>): AcpPathExecutableLister {
  return (command) => table[command] ?? [];
}

describe("discoverLocalAcpAgents — strategy-driven", () => {
  it("discovers exactly the installed agents (Gemini + Grok)", async () => {
    const probe = scriptedProbe({
      gemini: { version: "0.4.1", help: "usage\n  --acp  run as ACP server" },
      grok: { version: "1.2.0", help: "Run the agent over stdio" }
    });
    const agents = await discoverLocalAcpAgents({ probe, now: () => 42, listExecutables: noPathScan });
    expect(agents.map((a) => a.strategyId).sort()).toEqual(["gemini", "grok"]);
    const gemini = agents.find((a) => a.strategyId === "gemini")!;
    expect(gemini.command).toBe("gemini");
    // Gemini's ensureArgs append --skip-trust + the trust env.
    expect(gemini.args).toEqual(["--acp", "--skip-trust"]);
    expect(gemini.env).toMatchObject({ GEMINI_CLI_TRUST_WORKSPACE: "true" });
    expect(gemini.version).toBe("0.4.1");
  });

  it("matches a help string with the agent's ACP subcommand even amid other text", async () => {
    const probe = scriptedProbe({
      kimi: {
        version: "kimi version 2.0.0",
        help: "kimi acp — start the ACP server\nOther flags: --foo --bar"
      }
    });
    const agents = await discoverLocalAcpAgents({ probe, listExecutables: noPathScan });
    expect(agents.map((a) => a.strategyId)).toEqual(["kimi"]);
    expect(agents[0]?.args).toEqual(["acp"]);
  });

  it("tries fallback command paths when the bare name is missing (Grok)", async () => {
    const probe = scriptedProbe({
      "/opt/homebrew/bin/grok": { version: "1.0.0", help: "Run the agent over stdio" }
    });
    const agents = await discoverLocalAcpAgents({ probe, listExecutables: noPathScan });
    expect(agents).toHaveLength(1);
    expect(agents[0]?.command).toBe("/opt/homebrew/bin/grok");
  });

  it("finds Kimi at its ~/.kimi-code/bin install path with the REAL acp --help text", async () => {
    // The official Kimi Code installer (v0.11.0) drops a standalone binary here,
    // does NOT add it to PATH, and its `acp --help` says "Agent Client Protocol
    // (ACP) server over stdio" — regression guard for BOTH the missing fallback
    // and the help-regex that never matched "(ACP) server".
    const kimiPath = path.join(homedir(), ".kimi-code", "bin", "kimi");
    const probe = scriptedProbe({
      [kimiPath]: {
        version: "0.11.0",
        help: "Run kimi-code as an Agent Client Protocol (ACP) server over stdio."
      }
    });
    const agents = await discoverLocalAcpAgents({ probe, listExecutables: noPathScan });
    expect(agents.map((a) => a.strategyId)).toEqual(["kimi"]);
    expect(agents[0]?.command).toBe(kimiPath);
    expect(agents[0]?.version).toBe("0.11.0");
  });
});

describe("discoverLocalAcpAgentInstances — every installed instance", () => {
  it("returns ALL PATH matches of an agent, each with its own version + source", async () => {
    const nvmQwen = "/Users/me/.nvm/versions/node/v24.16.0/bin/qwen";
    const brewQwen = "/opt/homebrew/bin/qwen";
    const probe = scriptedProbe({
      [nvmQwen]: { version: "0.16.1", help: "flags: --acp run ACP server" },
      [brewQwen]: { version: "0.15.0", help: "flags: --acp run ACP server" }
    });
    const groups = await discoverLocalAcpAgentInstances({
      probe,
      now: () => 7,
      listExecutables: listFrom({ qwen: [nvmQwen, brewQwen] })
    });
    const qwen = groups.find((g) => g.strategyId === "qwen")!;
    expect(qwen.instances).toEqual([
      { command: nvmQwen, version: "0.16.1", source: "path" },
      { command: brewQwen, version: "0.15.0", source: "path" }
    ]);
    expect(qwen.args).toEqual(["--acp"]);
    expect(qwen.discoveredAt).toBe(7);
  });

  it("orders candidates override → PATH → fallback and dedups by command", async () => {
    const override = "/custom/grok";
    const pathGrok = "/usr/local/bin/grok";
    const probe = scriptedProbe({
      [override]: { version: "9.0.0", help: "Run the agent over stdio" },
      [pathGrok]: { version: "1.2.0", help: "Run the agent over stdio" },
      // ~/.grok/bin/grok fallback NOT installed → not in the map
      "/opt/homebrew/bin/grok": { version: "1.1.0", help: "Run the agent over stdio" }
    });
    const groups = await discoverLocalAcpAgentInstances({
      probe,
      overrides: { grok: override },
      listExecutables: listFrom({ grok: [pathGrok] })
    });
    const grok = groups.find((g) => g.strategyId === "grok")!;
    expect(grok.instances.map((i) => ({ command: i.command, source: i.source }))).toEqual([
      { command: override, source: "override" },
      { command: pathGrok, source: "path" },
      { command: "/opt/homebrew/bin/grok", source: "fallback" }
    ]);
  });

  it("legacy discoverLocalAcpAgents returns the FIRST instance of each group", async () => {
    const nvmQwen = "/Users/me/.nvm/versions/node/v24.16.0/bin/qwen";
    const brewQwen = "/opt/homebrew/bin/qwen";
    const probe = scriptedProbe({
      [nvmQwen]: { version: "0.16.1", help: "flags: --acp" },
      [brewQwen]: { version: "0.15.0", help: "flags: --acp" }
    });
    const agents = await discoverLocalAcpAgents({
      probe,
      listExecutables: listFrom({ qwen: [nvmQwen, brewQwen] })
    });
    const qwen = agents.find((a) => a.strategyId === "qwen")!;
    expect(qwen.command).toBe(nvmQwen);
    expect(qwen.version).toBe("0.16.1");
  });

  it("omits an agent with no passing instance", async () => {
    const probe = scriptedProbe({});
    const groups = await discoverLocalAcpAgentInstances({ probe, listExecutables: noPathScan });
    expect(groups).toEqual([]);
  });
});

describe("default executable lister — version-manager dirs", () => {
  it("lists every nvm node bin dir (newest-first) plus other manager dirs", async () => {
    const { mkdtempSync, mkdirSync } = await import("node:fs");
    const os = await import("node:os");
    const nodePath = await import("node:path");
    const { wellKnownAgentBinDirs } = await import(
      "../src/discovery/acp-local-discovery"
    );
    const home = mkdtempSync(nodePath.join(os.tmpdir(), "agentkit-home-"));
    for (const v of ["v20.0.0", "v24.16.0", "v22.1.0"]) {
      mkdirSync(nodePath.join(home, ".nvm", "versions", "node", v, "bin"), {
        recursive: true
      });
    }
    const dirs = wellKnownAgentBinDirs(home);
    // nvm bins come first, newest-first.
    expect(dirs.slice(0, 3)).toEqual([
      nodePath.join(home, ".nvm/versions/node/v24.16.0/bin"),
      nodePath.join(home, ".nvm/versions/node/v22.1.0/bin"),
      nodePath.join(home, ".nvm/versions/node/v20.0.0/bin")
    ]);
    // and the other well-known managers are included.
    expect(dirs).toContain(nodePath.join(home, ".bun/bin"));
    expect(dirs).toContain(nodePath.join(home, ".volta/bin"));
    expect(dirs).toContain("/opt/homebrew/bin");
  });

  it("discovers an agent installed under an nvm node version that is NOT on PATH", async () => {
    const { mkdtempSync, mkdirSync, writeFileSync, chmodSync } = await import(
      "node:fs"
    );
    const os = await import("node:os");
    const nodePath = await import("node:path");
    const home = mkdtempSync(nodePath.join(os.tmpdir(), "agentkit-nvm-"));
    const bin = nodePath.join(home, ".nvm", "versions", "node", "v24.16.0", "bin");
    mkdirSync(bin, { recursive: true });
    const qwenBin = nodePath.join(bin, "qwen");
    writeFileSync(qwenBin, "#!/bin/sh\n");
    chmodSync(qwenBin, 0o755);

    // PATH is launchd-minimal (no nvm) — the default lister must still find it
    // via the nvm scan. Probe scripted to accept exactly that resolved path.
    const probe = scriptedProbe({
      [qwenBin]: { version: "0.16.1", help: "flags: --acp run ACP server" }
    });
    const prevHome = process.env.HOME;
    process.env.HOME = home;
    try {
      const groups = await discoverLocalAcpAgentInstances({
        probe,
        env: { PATH: "/usr/bin:/bin" } as NodeJS.ProcessEnv
        // NOTE: real default lister (no listExecutables override) — exercises the nvm scan.
      });
      const qwen = groups.find((g) => g.strategyId === "qwen");
      expect(qwen?.instances).toEqual([
        { command: qwenBin, version: "0.16.1", source: "path" }
      ]);
    } finally {
      if (prevHome === undefined) delete process.env.HOME;
      else process.env.HOME = prevHome;
    }
  });
});

describe("strategy table extensibility (KTD-A2)", () => {
  // A synthetic 5th strategy: a new ACP agent added as a single table entry.
  const acmeStrategy: AcpAgentStrategy = {
    id: "acme",
    backendId: buildAcpBackendId("acme"),
    displayName: "Acme Coder",
    authors: ["Acme Inc"],
    discoveryProbe: {
      command: "acme",
      versionArgs: ["--version"],
      helpArgs: ["--help"],
      helpMatches: /--acp-stdio/
    },
    spawn: { command: "acme", args: ["--acp-stdio"] },
    quirks: defaultQuirks({ surfaceThoughts: false, titleFrom: "both" })
  };

  it("flows through discovery with zero normalizer changes", async () => {
    const probe = scriptedProbe({
      acme: { version: "9.9.9", help: "flags: --acp-stdio start ACP" }
    });
    const agents = await discoverLocalAcpAgents({
      probe,
      listExecutables: noPathScan,
      strategies: [...BUILT_IN_ACP_STRATEGIES, acmeStrategy]
    });
    const acme = agents.find((a) => a.strategyId === "acme");
    expect(acme).toMatchObject({ command: "acme", args: ["--acp-stdio"], backendId: "acp:acme" });
  });

  it("normalizes its stream using the same AcpSessionNormalizer (no agent-id branch)", () => {
    const normalizer = new AcpSessionNormalizer({ quirks: acmeStrategy.quirks });
    const ctx = { threadId: acmeStrategy.backendId, turnId: "t1" };
    // surfaceThoughts:false → thought suppressed; both → recognizes a summary title.
    expect(
      normalizer.apply(
        { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "secret" } },
        ctx
      ).events
    ).toEqual([]);
    expect(
      normalizer.apply(
        { sessionUpdate: "session_summary_generated", session_summary: "Acme Title" },
        ctx
      ).title
    ).toBe("Acme Title");
    // Ordinary message chunk still produces a delta — no special-casing.
    const events: NormalizedThreadEvent[] = normalizer.apply(
      { sessionUpdate: "agent_message_chunk", content: "hi" },
      ctx
    ).events;
    expect(events[0]).toMatchObject({ kind: "agent_message_delta", delta: "hi" });
  });

  it("drives a turn through AcpAgentClient using the synthetic strategy", async () => {
    const transport = new FakeAcpAgentTransport();
    const client = new AcpAgentClient({ transport, strategy: acmeStrategy, now: () => 1 });
    const { threadId } = await client.startThread();
    expect(threadId).toMatch(/^acp:acme:/);
    const events: NormalizedThreadEvent[] = [];
    client.onEvent((e) => events.push(e));
    const turn = client.startTurn({ threadId, input: { text: "go" } });
    transport.emitSessionUpdate("session-1", { sessionUpdate: "agent_message_chunk", content: "ok" });
    transport.finishPrompt();
    await turn;
    // startTurn resolves at turn START; the terminal agent_message streams when
    // the prompt settles, so flush a macrotask before asserting on it.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(events.some((e) => e.kind === "agent_message" && e.message.text === "ok")).toBe(true);
  });
});

describe("normalizer has no inline agent-id branch (KTD-A2 guard)", async () => {
  it("contains no `agentId ===` / `backendId ===` / `=== \"gemini\"` literal", async () => {
    const { readFile } = await import("node:fs/promises");
    const { fileURLToPath } = await import("node:url");
    const path = fileURLToPath(new URL("../src/normalizer/acp-normalizer.ts", import.meta.url));
    const source = await readFile(path, "utf8");
    expect(/agentId\s*===|backendId\s*===|===\s*["']gemini["']|===\s*["']grok["']|===\s*["']kimi["']|===\s*["']qwen["']/.test(source)).toBe(false);
  });
});
