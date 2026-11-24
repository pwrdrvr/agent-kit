// Keep the shell wrapper and label rules aligned with PwrAgent's
// packages/shared/src/command-action-labels.ts.
const MAX_COMMAND_LABEL_LENGTH = 72;

export function isGenericShellToolTitle(label: string): boolean {
  return /^(?:bash|shell|sh|zsh|terminal|tool)$/i.test(label.trim());
}

/** Unwrap POSIX and Windows interpreter invocations for display. */
function stripShellWrapper(command: string): string {
  return command
    .replace(/^(?:\/\S+\/)?(?:ba|z)?sh\s+-lc\s+/i, "")
    .replace(
      /^(?:"[^"]*(?:powershell|pwsh|cmd|bash)\.exe"|[^\s"]*(?:powershell|pwsh|cmd|bash)\.exe)\s+(?:-Command|-lc|-c|\/d\s+\/s\s+\/c|\/c)\s+/i,
      ""
    )
    .trim();
}

export function normalizeCommandText(command: string): string {
  const trimmed = command.trim();
  const unwrapped = stripShellWrapper(trimmed);
  // Strip the wrapper's matched quotes and keep quotes in bare commands.
  const script = unwrapped === trimmed
    ? unwrapped
    : unwrapped.replace(/^(['"])([\s\S]*)\1$/, "$2");
  return script.replace(/\s+/g, " ").trim();
}

export function formatCommandLabel(command: string): string {
  const collapsed = normalizeCommandText(command);
  if (!collapsed) {
    return "Ran command";
  }
  return collapsed.length > MAX_COMMAND_LABEL_LENGTH
    ? `${collapsed.slice(0, MAX_COMMAND_LABEL_LENGTH - 3)}...`
    : collapsed;
}
