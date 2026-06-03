import { homedir } from "node:os";
import path from "node:path";
import { buildAcpBackendId, defaultQuirks, type AcpAgentStrategy } from "./strategy-types";

export const qwenStrategy: AcpAgentStrategy = {
  id: "qwen",
  backendId: buildAcpBackendId("qwen"),
  displayName: "Qwen Code",
  authors: ["Qwen Team"],
  license: "Apache-2.0",
  repositoryUrl: "https://github.com/QwenLM/qwen-code",
  discoveryProbe: {
    command: "qwen",
    versionArgs: ["--version"],
    helpArgs: ["--help"],
    helpMatches: /(^|\s)--acp(\s|,|$)/,
    fallbackCommands: [
      path.join(homedir(), ".qwen", "bin", "qwen"),
      "/opt/homebrew/bin/qwen",
      "/usr/local/bin/qwen"
    ]
  },
  spawn: {
    command: "qwen",
    args: ["--acp"]
  },
  // Qwen's thought chunks are noisy internal scaffolding — suppress them.
  quirks: defaultQuirks({ surfaceThoughts: false, titleFrom: "topic-update" })
};
