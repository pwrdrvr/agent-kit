import { isGenericLabel } from "@pwrdrvr/agent-core";

// The length limit and wrapper handling come from PwrAgent's
// packages/shared/src/command-action-labels.ts.
const MAX_COMMAND_LABEL_LENGTH = 72;

export function isGenericShellToolTitle(label: string): boolean {
  return /^(?:bash|shell|sh|zsh|terminal)$/i.test(label.trim());
}

export function isCommandLabelFallback(label: string, command: string): boolean {
  if (isGenericLabel(label) || isGenericShellToolTitle(label)) return true;
  const title = oneLine(readCommandLabelText(label).display);
  const { display, scriptEchoes } = readCommandLabelText(command);
  return title === oneLine(display) ||
    (scriptEchoes?.some(echo => title === oneLine(echo)) ?? false);
}

function readPosixScriptWord(text: string): { length: number; display: string; echoes: string[] } | undefined {
  let length = 0;
  let decodedScript = "";
  let escapedScript = "";
  // Sticky matching stops at the first shell word boundary. Adjacent quoted
  // or escaped fragments belong to that same word.
  for (const [fragment, single, double, escaped] of text.matchAll(
    /'([^']*)'|"((?:[^"\\]|\\[\s\S])*)"|\\([\s\S])|[^\s'"\\;&|<>()]+/gy
  )) {
    const end = length + fragment.length;
    const literal = single ?? (escaped === "\n" ? "" : escaped);
    // Bash removes unquoted line continuations before recognizing $'…' or $"…".
    if (
      literal === undefined &&
      double === undefined &&
      fragment.endsWith("$") &&
      /^(?:\\\n)*['"]/.test(text.slice(end))
    ) {
      return undefined;
    }
    const doubleEcho = double?.replace(
      /\\(["\\$`\n])/g,
      (_, char: string) => char === "\n" ? "" : char
    );
    const decoded = literal ?? doubleEcho ?? fragment;
    // Preserve the display for a standalone double-quoted script. Joined
    // fragments display the decoded word the shell passes to -c.
    if (double !== undefined && fragment.length === text.length) {
      return { length: end, display: double, echoes: [decoded, double] };
    }
    decodedScript += decoded;
    escapedScript += literal ?? double ?? fragment;
    length = end;
  }
  // Providers can echo the script with or without the outer shell escapes.
  return { length, display: decodedScript, echoes: [decodedScript, escapedScript] };
}

/** Derive a label and the script text an agent may echo as its title. */
function readCommandLabelText(command: string): { display: string; scriptEchoes?: string[] } {
  const trimmed = command.trim();
  const posixWrapper = /^(?:\/\S+\/)?(?:ba|z)?sh\s+(-l?c|-C)\s+/.exec(trimmed);
  if (posixWrapper) {
    const tail = trimmed.slice(posixWrapper[0].length);
    const word = readPosixScriptWord(tail);
    if (word === undefined) return { display: trimmed };
    let display = trimmed;
    if (posixWrapper[1] !== "-C") {
      if (!/^['"]/.test(tail)) display = tail;
      else if (word.length === tail.length && word.display.trim()) display = word.display;
    }
    return word.length > 0 ? { display, scriptEchoes: word.echoes } : { display };
  }

  const unwrapped = trimmed
    .replace(
      /^(?:"[^"]*(?:powershell|pwsh|cmd|bash)\.exe"|[^\s"]*(?:powershell|pwsh|cmd|bash)\.exe)\s+(?:-Command|-lc|-c|\/d\s+\/s\s+\/c|\/c)\s+/i,
      ""
    )
    .trim();
  const display = unwrapped === trimmed
    ? unwrapped
    : unwrapped.replace(/^(['"])([\s\S]*)\1$/, "$2");
  return { display };
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

export function formatCommandLabel(command: string): string {
  const collapsed = oneLine(readCommandLabelText(command).display);
  if (!collapsed) {
    return "Ran command";
  }
  return collapsed.length > MAX_COMMAND_LABEL_LENGTH
    ? `${collapsed.slice(0, MAX_COMMAND_LABEL_LENGTH - 3)}...`
    : collapsed;
}
