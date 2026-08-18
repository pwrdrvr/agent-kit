---
"@pwrdrvr/codex-discovery": minor
---

Let callers scope the well-known Codex install locations that discovery probes. `discoverCodexCommands` and `resolveCodexCommand` accept an optional `installCandidatePaths` list, which *replaces* the platform defaults (spread `getCodexInstallCandidatePaths` into your own list to extend them instead), plus an optional `homeDir` used to expand the default list's user-local entries. `getCodexInstallCandidatePaths` is now exported, builds paths with the rules of the platform it is given rather than the host's, and falls back to the real home directory when handed a blank one. Both options default to today's behavior, so existing callers are unaffected.
