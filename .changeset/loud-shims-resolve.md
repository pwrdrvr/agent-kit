---
"@pwrdrvr/codex-discovery": minor
---

Resolve Windows commands through PATHEXT instead of the bare, unstartable command name.

`buildPathCommandNames` put the extensionless name FIRST in the list `resolvePathCommand` walks per PATH directory, and the scan returns its first hit. npm installs three shims side by side — `codex` (an sh script, for Git Bash), `codex.cmd`, and `codex.ps1` — so in any npm or nvm-windows bin directory the scan stopped on the sh script and never reached `codex.cmd`. Measured against a working Codex 0.146.0 install at `C:\nvm4w\nodejs\`: `where codex` lists the sh script first, discovery picked it, and the tool was reported missing. (`.PS1` is not in the default PATHEXT, so the `.ps1` was never the problem — the bare name was.)

On win32 the bare name is no longer a candidate at all: `CreateProcess` appends `.exe` to an extensionless name, so such a file cannot be launched by `child_process` regardless of where it sits in the list. Only a command carrying some other, non-PATHEXT extension (`tool.ps1`) keeps the verbatim name, tried last, so a caller who named a specific file can still discover it. A command that already ends in a PATHEXT extension still resolves to itself. PATH and PATHEXT are now both read case-insensitively on win32. **POSIX resolution is byte-for-byte unchanged** — the bare name is correct and the only option there.

This is not Codex-specific: `discoverCommands` is generic, so every consumer resolving a tool (`git`, `gh`, …) on a Windows npm-shim layout was hitting the same defect.

`pathIsExecutable` is fixed in the same pass rather than left as a known weakness. It used `access(X_OK)`, which on Windows has no execute bit to consult and degrades to "does this file exist" — it answered `true` for a README, so `candidate.executable` on win32 was asserting nothing. It now judges by PATHEXT there (the rule `CreateProcess` and `cmd.exe` actually apply) and confirms existence separately; POSIX still asks the filesystem. It takes a new optional second argument, `PathIsExecutableOptions` (`env`, `platform`), defaulting to `process.env` / `process.platform`, so the existing one-argument calls keep compiling. Discovery still ORs this with "the version probe actually ran", so a candidate proven to execute is unaffected.

Backward compatible: no exported name changed meaning off Windows, and nothing was removed. Consumers pinned to `^0.1.6` need to widen the range to pick this up.
