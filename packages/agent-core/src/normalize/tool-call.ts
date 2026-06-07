// Shared tool-call normalization helpers. Both the Codex adapter and the ACP
// adapter reuse these so streamed tool-call deltas merge identically and `kind`
// inference is consistent. Generalizes PwrAgnt's mergeActivity / preferSpecificLabel.

import type {
  NormalizedToolCall,
  NormalizedToolCallUpdate,
  NormalizedToolKind
} from "../schema/tool-call";

// Matched against whole tokens (see `tokenize`), not raw substrings — otherwise
// "frobnicate" would match "cat" and "duplicate" would match "cat"/"plica".
const KIND_HINTS: ReadonlyArray<readonly [NormalizedToolKind, readonly string[]]> = [
  ["search", ["search", "grep", "find", "lookup", "query", "ripgrep"]],
  ["fetch", ["fetch", "http", "request", "download", "curl", "url", "web"]],
  ["write", ["write", "edit", "patch", "apply", "create", "add", "update", "delete", "rename", "save", "redact", "crop", "draw", "set", "insert", "remove", "render", "compose", "mutate"]],
  ["command", ["exec", "run", "command", "shell", "bash", "sh", "spawn", "execute"]],
  ["read", ["read", "cat", "open", "view", "get", "list", "ls", "inspect", "show", "load"]]
];

/** Lowercased tokens, split on camelCase boundaries and non-alphanumerics. */
function tokenize(name: string): Set<string> {
  const tokens = name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length > 0);
  return new Set(tokens);
}

// Generic labels an adapter might emit before a more specific one arrives; a
// specific later label should win over these.
const GENERIC_LABELS = new Set([
  "tool",
  "tool call",
  // The humanized ACP `tool_call_update` sessionUpdate type — what an adapter
  // falls back to when an update notification carries no title/name (e.g. Grok).
  // Without these it counted as "specific" and clobbered the real tool name
  // carried by the initial tool_call.
  "tool call update",
  "tool_call_update",
  "command",
  "execute",
  "exec",
  "run",
  "read",
  "write",
  "search",
  "fetch",
  "working",
  "running"
]);

/**
 * Infer a coarse tool kind from a tool name. Heuristic and order-sensitive
 * (search/fetch/write/command/read), defaulting to "other". Adapters may
 * override when the backend already classifies the call.
 */
export function inferToolKind(name: string): NormalizedToolKind {
  const tokens = tokenize(name);
  for (const [kind, hints] of KIND_HINTS) {
    if (hints.some((hint) => tokens.has(hint))) {
      return kind;
    }
  }
  return "other";
}

/** True when a label is generic enough that a specific later label should replace it. */
export function isGenericLabel(label: string): boolean {
  return GENERIC_LABELS.has(label.trim().toLowerCase());
}

/**
 * Choose the better of two labels: a specific incoming label wins, but a generic
 * incoming label does not clobber an existing specific one. Empty/whitespace
 * incoming labels are ignored.
 */
export function preferSpecificLabel(current: string, incoming: string | undefined): string {
  if (incoming === undefined || incoming.trim() === "") return current;
  if (isGenericLabel(incoming) && !isGenericLabel(current) && current.trim() !== "") {
    return current;
  }
  return incoming;
}

/**
 * Merge a streamed `tool_call_update` into the prior `tool_call`. Defined fields
 * on the update overwrite (later state wins), the label is reconciled via
 * `preferSpecificLabel`, and nested command/fileDiff details are shallow-merged.
 * `undefined` update fields never erase prior values.
 */
export function mergeToolCall(
  prev: NormalizedToolCall,
  update: NormalizedToolCallUpdate
): NormalizedToolCall {
  const merged: NormalizedToolCall = { ...prev };

  if (update.name !== undefined) merged.name = update.name;
  if (update.kind !== undefined) merged.kind = update.kind;
  if (update.status !== undefined) merged.status = update.status;
  if (update.args !== undefined) merged.args = update.args;
  if (update.result !== undefined) merged.result = update.result;
  if (update.label !== undefined) merged.label = preferSpecificLabel(prev.label, update.label);

  if (update.command !== undefined) {
    merged.command = { ...prev.command, ...update.command };
  }
  if (update.fileDiff !== undefined) {
    merged.fileDiff = { ...prev.fileDiff, ...update.fileDiff };
  }
  // ACP sends the complete location list per update, so a later non-empty
  // `locations` replaces (not merges into) the prior one.
  if (update.locations !== undefined) {
    merged.locations = update.locations;
  }

  return merged;
}
