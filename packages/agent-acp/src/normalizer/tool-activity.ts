// ACP tool_call / tool_call_update / file / terminal → agent-core
// NormalizedToolCall. Reuses agent-core's `inferToolKind` for kind inference and
// `mergeToolCall` / `preferSpecificLabel` for delta merging, so ACP tool-call
// streams merge identically to Codex's.

import {
  inferToolKind,
  type NormalizedCommandDetail,
  type NormalizedToolCall,
  type NormalizedToolKind,
  type NormalizedToolStatus
} from "@pwrdrvr/agent-core";
import {
  asRecord,
  readContentText,
  readFirstLocationPath,
  readFirstString,
  readNumber,
  readString,
  readToolOutput
} from "./content";

/** Read the tool-call correlation id across every spelling agents use. */
export function readToolCallId(
  update: Record<string, unknown>,
  kind: string,
  sessionId: string
): string {
  return (
    readFirstString(
      update,
      "toolCallId",
      "tool_call_id",
      "id",
      "itemId",
      "item_id"
    ) ?? `${kind}:${sessionId}`
  );
}

/** Map an ACP status string onto a NormalizedToolStatus (pending → in_progress). */
function normalizeStatus(status: string | undefined): NormalizedToolStatus | undefined {
  switch (status) {
    case "completed":
    case "failed":
    case "cancelled":
    case "in_progress":
      return status;
    case "pending":
      return "in_progress";
    default:
      return undefined;
  }
}

/**
 * Choose the tool kind. ACP carries an explicit `kind` on tool calls
 * (read/edit/write/execute/search/…); when present it maps directly, otherwise
 * we fall back to agent-core's name-based `inferToolKind` over the label, and to
 * a command/read heuristic.
 */
function toolKindFor(
  acpKind: string | undefined,
  command: string | undefined,
  path: string | undefined,
  label: string
): NormalizedToolKind {
  switch (acpKind) {
    case "edit":
    case "write":
      return "write";
    case "execute":
    case "exec":
    case "shell":
      return "command";
    case "read":
      return "read";
    case "search":
      return "search";
    case "fetch":
      return "fetch";
    default:
      break;
  }
  if (command) return "command";
  const inferred = inferToolKind(label);
  if (inferred !== "other") return inferred;
  // A tool with a file path but no other signal is a read; otherwise unknown.
  return path ? "read" : "other";
}

/**
 * Normalize one ACP tool-ish update (tool_call / tool_call_update / file /
 * terminal) into a NormalizedToolCall. The result is fed to the normalizer's
 * upsert, which merges deltas with the same id via agent-core's `mergeToolCall`.
 */
export function toolCallFromUpdate(
  update: Record<string, unknown>,
  kind: string,
  sessionId: string
): NormalizedToolCall {
  const id = readToolCallId(update, kind, sessionId);
  const label =
    readString(update, "title") ??
    readString(update, "name") ??
    readString(update, "kind") ??
    kind.replaceAll("_", " ");
  const acpKind = readString(update, "kind");
  const path = readString(update, "path") ?? readFirstLocationPath(update);
  const command = readString(update, "command");
  const output = readToolOutput(update);
  const exitCode = readNumber(update, "exitCode") ?? readNumber(update, "exit_code");
  const status = normalizeStatus(readString(update, "status"));
  const toolKind = toolKindFor(acpKind, command, path, label);

  const call: NormalizedToolCall = {
    id,
    name: readString(update, "name") ?? acpKind ?? label,
    kind: toolKind,
    label,
    status: status ?? "in_progress",
    args: readToolArgs(update)
  };

  if (output !== undefined) {
    call.result = output;
  }

  // An explicit display target only when the update actually names one. A
  // kind-derived label ("execute") is NOT used here, so a later output-only
  // update never clobbers an earlier specific displayCommand on merge (the
  // normalizer reconciles displayCommand via preferSpecificLabel).
  const explicitDisplay = command ?? readString(update, "title");
  if (command || output !== undefined || exitCode !== undefined) {
    const detail: NormalizedCommandDetail = {
      displayCommand: explicitDisplay ?? label
    };
    if (command !== undefined) detail.rawCommand = command;
    if (output !== undefined) detail.output = output;
    if (exitCode !== undefined) detail.exitCode = exitCode;
    call.command = detail;
  }

  if ((toolKind === "write" || toolKind === "read") && path) {
    // Surface the path through the label-adjacent command detail so consumers
    // that render a file target can find it without an ACP-specific field.
    if (!call.command) {
      call.command = { displayCommand: label };
    }
  }

  return call;
}

function readToolArgs(update: Record<string, unknown>): unknown {
  const raw =
    update.rawInput ??
    update.raw_input ??
    update.input ??
    update.arguments ??
    update.args;
  return asRecord(raw) ?? (raw === undefined ? undefined : raw);
}

/** Tool output text from a content array, for permission prompts. */
export function readToolContentText(value: unknown): string | undefined {
  return readContentText({ content: value }, "content");
}
