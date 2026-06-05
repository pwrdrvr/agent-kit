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
    helpArgs: ["acp", "--help"],
    // Real `kimi acp --help` (v0.11.0): "Run kimi-code as an Agent Client
    // Protocol (ACP) server over stdio." The old /\bACP server\b/ never matched
    // — "(ACP) server" has a paren between ACP and "server". Match the protocol
    // name, or "ACP" loosely followed by "server".
    helpMatches: /agent client protocol|\bacp\b[\s)]*server\b/i,
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
