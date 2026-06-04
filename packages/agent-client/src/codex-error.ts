// Render a Codex `TurnError` into one human-readable transcript line. Ported
// from PwrSnap (PR #194 "surface Codex turn errors") so the kit — which now owns
// the controller — never drops a failed turn's cause. Never throws; always
// returns a non-empty string usable directly as transcript text.

import type { TurnError } from "@pwrdrvr/codex-app-server-protocol/v2";

const FALLBACK = "Codex returned an error";

export function formatCodexTurnError(error: TurnError | null | undefined): string {
  if (!error) return FALLBACK;
  const base = extractMessage(error.message) || FALLBACK;
  const details = error.additionalDetails?.trim();
  if (details && details.length > 0 && !base.includes(details)) {
    return `${base} (${details})`;
  }
  return base;
}

function extractMessage(raw: string | null | undefined): string {
  if (typeof raw !== "string") return "";
  const trimmed = raw.trim();
  if (trimmed.length === 0) return "";
  // Best-effort: unwrap a nested provider-error JSON blob. Only attempt a parse
  // when the text actually looks like JSON — a plain message is the common case
  // and must pass through verbatim.
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      const nested = nestedErrorMessage(JSON.parse(trimmed));
      if (nested) return nested;
    } catch {
      // Not JSON after all — fall through to the raw text.
    }
  }
  return trimmed;
}

function nestedErrorMessage(value: unknown): string {
  if (typeof value !== "object" || value === null) return "";
  const obj = value as Record<string, unknown>;
  const err = obj.error;
  if (typeof err === "object" && err !== null) {
    const inner = (err as Record<string, unknown>).message;
    if (typeof inner === "string" && inner.trim().length > 0) {
      return inner.trim();
    }
  }
  const message = obj.message;
  return typeof message === "string" ? message.trim() : "";
}
