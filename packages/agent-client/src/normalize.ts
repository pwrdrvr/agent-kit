// Codex App Server v2 → agent-core neutral schema.
//
// Every native Codex notification / server-request a turn produces is mapped
// here into one (or zero) `NormalizedThreadEvent`. Subscribers of the Codex
// adapter only ever see normalized shapes — the raw protocol stops at this
// boundary, so an ACP adapter emitting the same neutral events is a drop-in.
//
// The mapping is deliberately defensive: a notification we don't recognize, or
// a malformed payload, yields `null` (no event) rather than throwing — a
// streaming turn must never die on an unexpected wire shape.

import {
  inferToolKind,
  type NormalizedThreadEvent,
  type NormalizedToolCall,
  type NormalizedToolCallUpdate,
  type NormalizedToolKind,
  type NormalizedToolStatus,
  type NormalizedTokenUsage,
  type NormalizedTurnStatus,
  type NormalizedApprovalKind,
  type NormalizedApprovalRequest,
  type NormalizedThreadSettings,
  type NormalizedMessage
} from "@pwrdrvr/agent-core";
import type {
  AgentMessageDeltaNotification,
  DynamicToolCallParams,
  ItemCompletedNotification,
  ItemStartedNotification,
  ModelReroutedNotification,
  ReasoningTextDeltaNotification,
  ThreadItem,
  ThreadSettingsUpdatedNotification,
  ThreadTokenUsage,
  ThreadTokenUsageUpdatedNotification,
  TurnCompletedNotification,
  TurnStartedNotification,
  TurnStatus
} from "@pwrdrvr/codex-app-server-protocol/v2";

// ---- wire method strings ----
// These are the App Server JSON-RPC method names a turn emits. Kept as bare
// strings (not protocol types — the wire carries strings) so the adapter routes
// `(method, params)` straight through `normalizeNotification`.

export const CODEX_NOTIFICATION_METHODS = {
  agentMessageDelta: "item/agentMessage/delta",
  reasoningDelta: "item/reasoning/delta",
  reasoningTextDelta: "item/reasoning/textDelta",
  itemStarted: "item/started",
  itemCompleted: "item/completed",
  turnStarted: "turn/started",
  turnCompleted: "turn/completed",
  tokenUsage: "thread/tokenUsage/updated",
  threadSettings: "thread/settings/updated",
  modelRerouted: "model/rerouted",
  error: "error"
} as const;

/** Codex approval ServerRequest methods, normalized into `approval_request`. */
export const CODEX_APPROVAL_METHODS = new Set<string>([
  "item/commandExecution/requestApproval",
  "item/fileChange/requestApproval",
  "item/permissions/requestApproval",
  "item/tool/requestUserInput",
  // Legacy v1 method names — older Codex builds still emit these.
  "applyPatchApproval",
  "execCommandApproval"
]);

/** The dynamic-tool ServerRequest method Codex routes tool invocations on. */
export const CODEX_TOOL_CALL_METHOD = "item/tool/call";

// ---- usage ----

/** Map a Codex `ThreadTokenUsage` (its `last` breakdown) to the neutral shape. */
export function normalizeTokenUsage(usage: ThreadTokenUsage): NormalizedTokenUsage {
  const last = usage.last;
  return {
    inputTokens: last.inputTokens,
    cachedInputTokens: last.cachedInputTokens,
    outputTokens: last.outputTokens,
    reasoningOutputTokens: last.reasoningOutputTokens,
    totalTokens: last.totalTokens
  };
}

// ---- turn status ----

function normalizeTurnStatus(status: TurnStatus | string): NormalizedTurnStatus {
  switch (status) {
    case "completed":
      return "completed";
    case "failed":
      return "failed";
    case "interrupted":
      return "interrupted";
    case "inProgress":
      return "in_progress";
    case "aborted":
    case "cancelled":
    case "canceled":
      return "cancelled";
    default:
      return "failed";
  }
}

// ---- tool call (from a ThreadItem) ----

const DYNAMIC_TOOL_STATUS: Record<string, NormalizedToolStatus> = {
  inProgress: "in_progress",
  completed: "completed",
  failed: "failed"
};

const COMMAND_STATUS: Record<string, NormalizedToolStatus> = {
  inProgress: "in_progress",
  completed: "completed",
  failed: "failed",
  declined: "cancelled"
};

/** Render the content items a dynamic tool returned as a single string result. */
function joinDynamicResult(
  contentItems: Extract<ThreadItem, { type: "dynamicToolCall" }>["contentItems"]
): string | undefined {
  if (contentItems === null) return undefined;
  const text = contentItems
    .map((item) => (item.type === "inputText" ? item.text : item.imageUrl))
    .join("");
  return text.length > 0 ? text : undefined;
}

/**
 * Build a `NormalizedToolCall` from a tool-ish `ThreadItem`. Returns `null` for
 * non-tool items. `kind` defaults to `inferToolKind(name)` unless the item's
 * native shape already classifies it (a command execution is always "command").
 */
export function normalizeThreadItemToolCall(item: ThreadItem): NormalizedToolCall | null {
  if (item.type === "dynamicToolCall") {
    const kind: NormalizedToolKind = inferToolKind(item.tool);
    const status = DYNAMIC_TOOL_STATUS[item.status] ?? "in_progress";
    const call: NormalizedToolCall = {
      id: item.id,
      name: item.tool,
      kind,
      label: item.tool,
      status,
      args: item.arguments
    };
    const result = joinDynamicResult(item.contentItems);
    if (result !== undefined) call.result = result;
    return call;
  }

  if (item.type === "commandExecution") {
    const status = COMMAND_STATUS[item.status] ?? "in_progress";
    const call: NormalizedToolCall = {
      id: item.id,
      name: "command",
      kind: "command",
      label: item.command,
      status,
      command: {
        displayCommand: item.command,
        rawCommand: item.command,
        cwd: item.cwd,
        ...(item.aggregatedOutput !== null ? { output: item.aggregatedOutput } : {}),
        ...(item.exitCode !== null ? { exitCode: item.exitCode } : {}),
        ...(item.durationMs !== null ? { durationMs: item.durationMs } : {})
      }
    };
    return call;
  }

  if (item.type === "webSearch") {
    return {
      id: item.id,
      name: "web_search",
      kind: "search",
      label: item.query,
      status: "completed",
      args: { query: item.query }
    };
  }

  if (item.type === "fileChange") {
    return {
      id: item.id,
      name: "file_change",
      kind: "write",
      label: "Edit files",
      status: item.status === "completed" ? "completed" : "in_progress"
    };
  }

  return null;
}

/**
 * Build a `NormalizedToolCall` from a `DynamicToolCallParams` (the ServerRequest
 * the adapter must answer). `kind` defaults to `inferToolKind(name)`.
 */
export function normalizeDynamicToolCall(params: DynamicToolCallParams): NormalizedToolCall {
  return {
    id: params.callId,
    name: params.tool,
    kind: inferToolKind(params.tool),
    label: params.tool,
    status: "in_progress",
    args: params.arguments
  };
}

// ---- approvals ----

function approvalKindForMethod(method: string): NormalizedApprovalKind {
  if (method.includes("commandExecution") || method === "execCommandApproval") return "exec";
  if (method.includes("fileChange") || method === "applyPatchApproval") return "patch";
  if (method.includes("tool")) return "tool";
  return "other";
}

/** Normalize a Codex approval ServerRequest into a neutral approval request. */
export function normalizeApprovalRequest(
  method: string,
  params: unknown,
  approvalId: string
): NormalizedApprovalRequest {
  const p = (params ?? {}) as Record<string, unknown>;
  const summary =
    typeof p.reason === "string"
      ? p.reason
      : typeof p.command === "string"
        ? p.command
        : undefined;
  const request: NormalizedApprovalRequest = {
    id: approvalId,
    method,
    kind: approvalKindForMethod(method),
    params
  };
  if (summary !== undefined) request.summary = summary;
  return request;
}

// ---- thread settings ----

export function normalizeThreadSettings(
  notification: ThreadSettingsUpdatedNotification
): NormalizedThreadSettings {
  return {
    threadId: notification.threadId,
    model: notification.threadSettings.model,
    modelProvider: notification.threadSettings.modelProvider,
    serviceTier: notification.threadSettings.serviceTier
  };
}

// ---- top-level notification dispatch ----

function isToolish(item: ThreadItem): boolean {
  return (
    item.type === "dynamicToolCall" ||
    item.type === "commandExecution" ||
    item.type === "webSearch" ||
    item.type === "fileChange"
  );
}

function toUpdate(call: NormalizedToolCall): NormalizedToolCallUpdate {
  return call;
}

function agentMessageFromItem(item: ThreadItem): NormalizedMessage | null {
  if (item.type !== "agentMessage") return null;
  return { id: item.id, role: "assistant", text: item.text };
}

/**
 * Normalize one native Codex notification into a `NormalizedThreadEvent`.
 * Returns `null` when the method/payload yields no neutral event (an unknown
 * method, or an `item/*` carrying a non-streamable item).
 *
 * `item/started` for a tool-ish item becomes a `tool_call`; the matching
 * `item/completed` becomes a `tool_call_update` (so the controller correlates
 * them by id and merges via `mergeToolCall`). An `agentMessage` `item/completed`
 * becomes a final `agent_message`.
 */
export function normalizeNotification(
  method: string,
  params: unknown
): NormalizedThreadEvent | null {
  switch (method) {
    case CODEX_NOTIFICATION_METHODS.agentMessageDelta: {
      const n = params as AgentMessageDeltaNotification;
      return {
        kind: "agent_message_delta",
        threadId: n.threadId,
        turnId: n.turnId,
        itemId: n.itemId,
        delta: n.delta
      };
    }
    case CODEX_NOTIFICATION_METHODS.reasoningDelta:
    case CODEX_NOTIFICATION_METHODS.reasoningTextDelta: {
      const n = params as ReasoningTextDeltaNotification;
      return {
        kind: "reasoning_delta",
        threadId: n.threadId,
        turnId: n.turnId,
        itemId: n.itemId,
        delta: n.delta
      };
    }
    case CODEX_NOTIFICATION_METHODS.turnStarted: {
      const n = params as TurnStartedNotification;
      return { kind: "turn_started", threadId: n.threadId, turnId: n.turn.id };
    }
    case CODEX_NOTIFICATION_METHODS.turnCompleted: {
      const n = params as TurnCompletedNotification;
      return {
        kind: "turn_completed",
        threadId: n.threadId,
        turnId: n.turn.id,
        status: normalizeTurnStatus(n.turn.status)
      };
    }
    case CODEX_NOTIFICATION_METHODS.tokenUsage: {
      const n = params as ThreadTokenUsageUpdatedNotification;
      return {
        kind: "token_usage",
        threadId: n.threadId,
        turnId: n.turnId,
        usage: normalizeTokenUsage(n.tokenUsage)
      };
    }
    case CODEX_NOTIFICATION_METHODS.threadSettings: {
      const n = params as ThreadSettingsUpdatedNotification;
      return { kind: "thread_settings", settings: normalizeThreadSettings(n) };
    }
    case CODEX_NOTIFICATION_METHODS.modelRerouted: {
      const n = params as ModelReroutedNotification;
      return {
        kind: "thread_settings",
        settings: {
          threadId: n.threadId,
          model: n.toModel,
          modelProvider: "openai",
          serviceTier: null
        }
      };
    }
    case CODEX_NOTIFICATION_METHODS.itemStarted: {
      const n = params as ItemStartedNotification;
      if (isToolish(n.item)) {
        const call = normalizeThreadItemToolCall(n.item);
        if (call === null) return null;
        return { kind: "tool_call", threadId: n.threadId, turnId: n.turnId, toolCall: call };
      }
      return null;
    }
    case CODEX_NOTIFICATION_METHODS.itemCompleted: {
      const n = params as ItemCompletedNotification;
      const message = agentMessageFromItem(n.item);
      if (message !== null) {
        return {
          kind: "agent_message",
          threadId: n.threadId,
          turnId: n.turnId,
          message
        };
      }
      if (isToolish(n.item)) {
        const call = normalizeThreadItemToolCall(n.item);
        if (call === null) return null;
        return {
          kind: "tool_call_update",
          threadId: n.threadId,
          turnId: n.turnId,
          toolCall: toUpdate(call)
        };
      }
      return null;
    }
    case CODEX_NOTIFICATION_METHODS.error: {
      const p = (params ?? {}) as Record<string, unknown>;
      const message = typeof p.message === "string" ? p.message : "codex error";
      const event: Extract<NormalizedThreadEvent, { kind: "error" }> = {
        kind: "error",
        message
      };
      if (typeof p.threadId === "string") event.threadId = p.threadId;
      if (typeof p.turnId === "string") event.turnId = p.turnId;
      if (typeof p.code === "string") event.code = p.code;
      return event;
    }
    default:
      return null;
  }
}
