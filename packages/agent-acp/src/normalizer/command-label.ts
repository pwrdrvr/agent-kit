import { isGenericLabel } from "@pwrdrvr/agent-core";

// The length limit and wrapper handling come from PwrAgent's
// packages/shared/src/command-action-labels.ts.
const MAX_COMMAND_LABEL_LENGTH = 72;

export function isGenericShellToolTitle(label: string): boolean {
  return /^(?:bash|shell|sh|zsh|terminal)$/i.test(label.trim());
}

export function isCommandLabelFallback(label: string, command: string): boolean {
  return isGenericLabel(label) ||
    isGenericShellToolTitle(label) ||
    normalizeCommandText(label) === normalizeCommandText(command);
}

/** Unwrap POSIX and Windows interpreter invocations for display. */
function unwrapCommandText(command: string): string {
  const trimmed = command.trim();
  const posixWrapper = /^(?:\/\S+\/)?(?:ba|z)?sh\s+-l?c\s+/.exec(trimmed);
  if (posixWrapper) {
    const script = trimmed.slice(posixWrapper[0].length);
    // A quoted script can be followed by positional arguments. Keep the
    // invocation when those arguments are present or the script is blank.
    const quotedScript = /^(?:'[^']*'|"(?:[^"\\]|\\[\s\S])*")/.exec(script)?.[0];
    if (quotedScript === undefined) return script;
    const body = quotedScript.slice(1, -1);
    return quotedScript.length === script.length && body.trim() ? body : trimmed;
  }

  const unwrapped = trimmed
    .replace(
      /^(?:"[^"]*(?:powershell|pwsh|cmd|bash)\.exe"|[^\s"]*(?:powershell|pwsh|cmd|bash)\.exe)\s+(?:-Command|-lc|-c|\/d\s+\/s\s+\/c|\/c)\s+/i,
      ""
    )
    .trim();
  return unwrapped === trimmed
    ? unwrapped
    : unwrapped.replace(/^(['"])([\s\S]*)\1$/, "$2");
}

function normalizeCommandText(command: string): string {
  return unwrapCommandText(command).replace(/\s+/g, " ").trim();
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
