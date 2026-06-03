// The materialized transcript shape — what a thread store persists and a chat
// UI renders. Mirrors PwrAgnt's AppServerThreadReplay (entries + messages +
// status) re-targeted as the kit's neutral vocabulary.

import type { NormalizedToolCall, NormalizedToolStatus } from "./tool-call";

export type ThreadId = string;
export type TurnId = string;

export type NormalizedRole = "user" | "assistant" | "system";

export type NormalizedTextPart = { type: "text"; text: string };
export type NormalizedImagePart = { type: "image"; url: string; alt?: string };
export type NormalizedMessagePart = NormalizedTextPart | NormalizedImagePart;

export type NormalizedMessage = {
  id: string;
  role: NormalizedRole;
  text: string;
  parts?: NormalizedMessagePart[];
  createdAt?: number;
};

export type NormalizedTurnStatus =
  | "in_progress"
  | "completed"
  | "failed"
  | "cancelled"
  | "interrupted";

export type NormalizedTurnMetadata = {
  id: TurnId;
  status?: NormalizedTurnStatus;
  startedAt?: number;
  completedAt?: number;
  durationMs?: number;
};

export type NormalizedPlanStepStatus = "pending" | "in_progress" | "completed";
export type NormalizedPlanStep = { step: string; status: NormalizedPlanStepStatus };

export type NormalizedPlan = {
  id: string;
  steps: NormalizedPlanStep[];
  explanation?: string;
  markdown?: string;
};

export type NormalizedMessageEntry = NormalizedMessage & {
  type: "message";
  turn?: NormalizedTurnMetadata;
};

export type NormalizedActivityEntry = {
  type: "activity";
  id: string;
  summary: string;
  status?: NormalizedToolStatus;
  toolCalls: NormalizedToolCall[];
  createdAt?: number;
  turn?: NormalizedTurnMetadata;
};

export type NormalizedPlanEntry = NormalizedPlan & {
  type: "plan";
  createdAt?: number;
  turn?: NormalizedTurnMetadata;
};

export type NormalizedThreadEntry =
  | NormalizedMessageEntry
  | NormalizedActivityEntry
  | NormalizedPlanEntry;

// Coarse activity of a materialized/persisted thread. Distinct from the
// controller's live lifecycle `NormalizedThreadStatus` (the discriminated
// idle/streaming/awaiting_approval union in thread-record.ts) — this one is the
// at-rest summary a transcript carries.
export type NormalizedThreadActivity = "active" | "idle" | "unknown";

export type NormalizedThread = {
  id: ThreadId;
  entries: NormalizedThreadEntry[];
  messages: NormalizedMessage[];
  status?: NormalizedThreadActivity;
  lastUserMessage?: string;
  lastAssistantMessage?: string;
};

export type NormalizedThreadSummary = {
  id: ThreadId;
  title?: string;
  status?: NormalizedThreadActivity;
  updatedAt?: number;
};

export function createEmptyThread(id: ThreadId): NormalizedThread {
  return { id, entries: [], messages: [], status: "active" };
}
