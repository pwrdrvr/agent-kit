import { homedir } from "node:os";
import path from "node:path";
import { buildAcpBackendId, defaultQuirks, type AcpAgentStrategy } from "./strategy-types";

export const grokStrategy: AcpAgentStrategy = {
  id: "grok",
  backendId: buildAcpBackendId("grok"),
  displayName: "Grok",
  authors: ["xAI"],
  discoveryProbe: {
    command: "grok",
    versionArgs: ["--version"],
    helpArgs: ["agent", "stdio", "--help"],
    helpMatches: /Run the agent over stdio/i,
    fallbackCommands: [
      path.join(homedir(), ".grok", "bin", "grok"),
      "/opt/homebrew/bin/grok",
      "/usr/local/bin/grok"
    ]
  },
  spawn: {
    command: "grok",
    args: ["agent", "stdio"]
  },
  // Grok auto-generates the thread title via its vendor notification
  // `_x.ai/session_notification` carrying `session_summary_generated`.
  quirks: defaultQuirks({
    surfaceThoughts: true,
    titleFrom: "session-summary",
    vendorNotificationMethods: ["_x.ai/session_notification"]
  })
};
