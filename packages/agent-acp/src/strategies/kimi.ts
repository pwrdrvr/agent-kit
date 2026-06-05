import { homedir } from "node:os";
import path from "node:path";
import { buildAcpBackendId, defaultQuirks, type AcpAgentStrategy } from "./strategy-types";

export const kimiStrategy: AcpAgentStrategy = {
  id: "kimi",
  backendId: buildAcpBackendId("kimi"),
  displayName: "Kimi Code CLI",
  authors: ["Moonshot AI"],
  discoveryProbe: {
    command: "kimi",
    versionArgs: ["--version"],
    // Capability signal is the EXIT CODE of `kimi acp --help`, NOT its prose.
    // kimi's commander CLI exits non-zero for an unknown subcommand, so a
    // zero-exit proves the `acp` subcommand exists. No `helpMatches`: the help
    // wording has already drifted across kimi versions (0.11.0 prints "Agent
    // Client Protocol (ACP) server over stdio"), so matching it is fragile.
    helpArgs: ["acp", "--help"],
    // The official Kimi Code installer drops a standalone binary at
    // ~/.kimi-code/bin/kimi and does NOT add it to PATH — so a Finder-launched
    // app misses it without this fallback (mirrors grok/qwen).
    fallbackCommands: [
      path.join(homedir(), ".kimi-code", "bin", "kimi"),
      "/opt/homebrew/bin/kimi",
      "/usr/local/bin/kimi"
    ]
  },
  spawn: {
    command: "kimi",
    args: ["acp"]
  },
  quirks: defaultQuirks({ surfaceThoughts: true, titleFrom: "topic-update" })
};
