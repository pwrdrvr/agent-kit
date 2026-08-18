---
"@pwrdrvr/codex-discovery": minor
---

Let callers scope the well-known Codex install locations that discovery probes. `discoverCodexCommands` and `resolveCodexCommand` accept an optional `installCandidatePaths` list (defaulting to the platform list) and an optional `homeDir` used to expand its user-local entries, and `getCodexInstallCandidatePaths` is now exported so hosts can extend that default rather than replace it. Both options default to today's behavior, so existing callers are unaffected.
