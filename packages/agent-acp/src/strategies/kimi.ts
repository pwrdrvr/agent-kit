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
    helpMatches: /\bACP server\b/i
  },
  spawn: {
    command: "kimi",
    args: ["acp"]
  },
  quirks: defaultQuirks({ surfaceThoughts: true, titleFrom: "topic-update" })
};
