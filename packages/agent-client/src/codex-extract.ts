// Small, dependency-free extractors for reading ids/strings out of loosely-typed
// Codex App Server responses. Ported verbatim from PwrSnap/PwrAgent's in-tree
// Codex client so the kit's native methods (steer / compact / review) resolve
// thread/turn ids with the same tolerance for snake_case / nested `turn` shapes.

export function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

export function pickString(
  record: Record<string, unknown>,
  keys: string[]
): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value !== "string") continue;
    const trimmed = value.trim();
    if (trimmed) return trimmed;
  }
  return undefined;
}

export function extractThreadIdFromValue(value: unknown): string | undefined {
  const record = asRecord(value);
  if (!record) return undefined;
  const threadRecord = asRecord(record.thread) ?? asRecord(record.session);
  return (
    pickString(record, ["threadId", "thread_id", "conversationId", "conversation_id"]) ??
    pickString(threadRecord ?? {}, ["id", "threadId", "thread_id", "conversationId"])
  );
}

export function extractTurnIdFromValue(value: unknown): string | undefined {
  const record = asRecord(value);
  if (!record) return undefined;
  const turnRecord = asRecord(record.turn);
  return (
    pickString(record, ["turnId", "turn_id", "runId", "run_id"]) ??
    pickString(turnRecord ?? {}, ["id", "turnId", "turn_id", "runId", "run_id"])
  );
}

export function extractStringProperty(
  value: unknown,
  ...keys: string[]
): string | undefined {
  const record = asRecord(value);
  if (!record) return undefined;
  for (const key of keys) {
    const candidate = record[key];
    if (typeof candidate === "string" && candidate.trim()) {
      return candidate.trim();
    }
  }
  return undefined;
}
