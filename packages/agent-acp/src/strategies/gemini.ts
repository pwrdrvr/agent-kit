import { buildAcpBackendId, defaultQuirks, type AcpAgentStrategy } from "./strategy-types";

export const geminiStrategy: AcpAgentStrategy = {
  id: "gemini",
  backendId: buildAcpBackendId("gemini"),
  displayName: "Gemini CLI",
  authors: ["Google"],
  discoveryProbe: {
    command: "gemini",
    versionArgs: ["--version"],
    helpArgs: ["--help"],
    helpMatches: /(^|\s)--acp(\s|,|$)/
  },
  spawn: {
    command: "gemini",
    args: ["--acp"],
    // Gemini refuses to operate without workspace trust; matching PwrAgnt's
    // launch-descriptor normalization, append --skip-trust + set the env flag.
    ensureArgs: ["--skip-trust"],
    env: { GEMINI_CLI_TRUST_WORKSPACE: "true" }
  },
  quirks: defaultQuirks({ surfaceThoughts: true, titleFrom: "topic-update" })
};
