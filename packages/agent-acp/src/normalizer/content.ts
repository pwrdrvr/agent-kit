// camel/snake-tolerant readers + recursive ACP content unwrapping. ACP agents
// are wildly inconsistent: the same field arrives camelCase from one agent and
// snake_case from another, and content blocks nest arbitrarily
// (`content` → `[{ type: "content", content: { type: "text", text } }]`).
// Every reader here tolerates both casings and unwraps recursively.

export function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export function readString(
  record: Record<string, unknown> | undefined,
  key: string
): string | undefined {
  const value = record?.[key];
  return typeof value === "string" ? value : undefined;
}

export function readNonEmptyString(
  record: Record<string, unknown> | undefined,
  key: string
): string | undefined {
  const value = record?.[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function readNumber(
  record: Record<string, unknown> | undefined,
  key: string
): number | undefined {
  const value = record?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function readBoolean(
  record: Record<string, unknown> | undefined,
  key: string
): boolean | undefined {
  const value = record?.[key];
  return typeof value === "boolean" ? value : undefined;
}

/**
 * Read the first defined string among the given keys, in order. Used for
 * camel/snake parity (`toolCallId` vs `tool_call_id`).
 */
export function readFirstString(
  record: Record<string, unknown> | undefined,
  ...keys: string[]
): string | undefined {
  for (const key of keys) {
    const value = readString(record, key);
    if (value !== undefined) return value;
  }
  return undefined;
}

/** The session-update kind, tolerant of all four key spellings. */
export function readKind(update: Record<string, unknown>): string {
  return (
    readString(update, "sessionUpdate") ??
    readString(update, "session_update") ??
    readString(update, "kind") ??
    readString(update, "type") ??
    "unknown"
  );
}

/**
 * Recursively unwrap an ACP content value to plain text. Handles a bare string,
 * an array of content blocks (joined with newlines), and nested
 * `{ type:"text", text }` / `{ content }` / `{ text }` / `{ output }` /
 * `{ result }` shapes.
 */
export function readAcpContentText(value: unknown): string | undefined {
  if (typeof value === "string") {
    return value;
  }

  if (Array.isArray(value)) {
    const parts = value
      .map((item) => readAcpContentText(item))
      .filter((item): item is string => Boolean(item));
    return parts.length > 0 ? parts.join("\n") : undefined;
  }

  const content = asRecord(value);
  if (!content) {
    return undefined;
  }

  if (content.type === "text" && typeof content.text === "string") {
    return content.text;
  }
  return (
    readAcpContentText(content.content) ??
    readAcpContentText(content.text) ??
    readAcpContentText(content.output) ??
    readAcpContentText(content.result)
  );
}

export function readContentText(
  record: Record<string, unknown>,
  key: string
): string | undefined {
  return readAcpContentText(record[key]);
}

/** Tool output, checked across all the spellings agents use. */
export function readToolOutput(record: Record<string, unknown>): string | undefined {
  return (
    readString(record, "output") ??
    readString(record, "stdout") ??
    readString(record, "stderr") ??
    readString(record, "result") ??
    readContentText(record, "content")
  );
}

/** First location path from an ACP `locations: [{ path }]` array. */
export function readFirstLocationPath(
  record: Record<string, unknown>
): string | undefined {
  const locations = record.locations ?? record.location;
  if (!Array.isArray(locations)) {
    return undefined;
  }
  for (const location of locations) {
    const path = readString(asRecord(location), "path");
    if (path && path.trim()) {
      return path;
    }
  }
  return undefined;
}

/** The assistant/user text carried by a chunk update (camel/snake tolerant). */
export function readUpdateText(update: Record<string, unknown>): string | undefined {
  return (
    readString(update, "text") ??
    readString(update, "outputText") ??
    readString(update, "output_text") ??
    readContentText(update, "content")
  );
}
