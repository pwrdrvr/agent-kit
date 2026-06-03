// The live streaming event union — the wire a backend adapter emits as a turn
// runs. Mirrors PwrSnap's CodexThreadClient subscriber hooks (message deltas,
// turn lifecycle, token usage, settings, tool calls, approvals), generalized so
// the ACP adapter emits the same shapes. Consumers subscribe to this and never
// see a backend's native notification.

import type {
  ThreadId,
  TurnId,
  NormalizedMessage,
  NormalizedTurnStatus,
  NormalizedPlan
} from "./thread";
import type { NormalizedToolCall, NormalizedToolCallUpdate } from "./tool-call";
import type { NormalizedTokenUsage } from "./usage";
import type { NormalizedApprovalRequest } from "./approval";

export type NormalizedThreadSettings = {
  threadId: ThreadId;
  model?: string;
  modelProvider?: string;
  serviceTier?: string | null;
  // KTD-A1 widening (shared by Codex too, not ACP-only): ACP agents expose a
  // settable execution *mode* (Gemini/Grok "modes") distinct from the model.
  // Codex has no mode concept today, so it simply omits this. A backend
  // reports the id it changed to; the human-facing label rides `modeLabel`.
  modeId?: string;
  modeLabel?: string;
};

export type NormalizedThreadEvent =
  | { kind: "turn_started"; threadId: ThreadId; turnId: TurnId }
  | { kind: "agent_message_delta"; threadId: ThreadId; turnId: TurnId; itemId: string; delta: string }
  | { kind: "agent_message"; threadId: ThreadId; turnId: TurnId; message: NormalizedMessage }
  | { kind: "reasoning_delta"; threadId: ThreadId; turnId: TurnId; itemId: string; delta: string }
  | { kind: "tool_call"; threadId: ThreadId; turnId: TurnId; toolCall: NormalizedToolCall }
  | { kind: "tool_call_update"; threadId: ThreadId; turnId: TurnId; toolCall: NormalizedToolCallUpdate }
  | { kind: "plan_update"; threadId: ThreadId; turnId?: TurnId; plan: NormalizedPlan }
  | { kind: "token_usage"; threadId: ThreadId; turnId: TurnId; usage: NormalizedTokenUsage }
  | { kind: "thread_settings"; settings: NormalizedThreadSettings }
  | { kind: "approval_request"; threadId: ThreadId; turnId?: TurnId; approval: NormalizedApprovalRequest }
  | { kind: "turn_completed"; threadId: ThreadId; turnId: TurnId; status: NormalizedTurnStatus }
  | { kind: "error"; threadId?: ThreadId; turnId?: TurnId; message: string; code?: string };

export type NormalizedThreadEventKind = NormalizedThreadEvent["kind"];

/** Narrow a thread event to a specific kind. */
export function isThreadEventKind<K extends NormalizedThreadEventKind>(
  event: NormalizedThreadEvent,
  kind: K
): event is Extract<NormalizedThreadEvent, { kind: K }> {
  return event.kind === kind;
}
