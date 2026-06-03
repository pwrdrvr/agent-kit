// The neutral tool-call shape. Every backend (Codex App Server, ACP agents)
// normalizes its native tool/command/file activity into this so the controller
// and UI never branch per backend. Derived from the union of PwrSnap's dynamic
// tool-call surface and PwrAgnt's AppServerThreadActivityDetail.

export type NormalizedToolKind =
  | "read"
  | "write"
  | "command"
  | "search"
  | "fetch"
  | "other";

export type NormalizedToolStatus =
  | "pending"
  | "in_progress"
  | "completed"
  | "failed"
  | "cancelled";

export type NormalizedFileChangeKind = "add" | "delete" | "update";

export type NormalizedFileDiff = {
  kind: NormalizedFileChangeKind;
  path?: string;
  diff: string;
  additions: number;
  removals: number;
};

export type NormalizedCommandDetail = {
  displayCommand: string;
  rawCommand?: string;
  cwd?: string;
  output?: string;
  exitCode?: number;
  durationMs?: number;
};

export type NormalizedToolCall = {
  /** Stable id correlating a tool_call with its later tool_call_update(s). */
  id: string;
  /** Tool name as the model invoked it (a host dynamic tool, or a backend builtin). */
  name: string;
  kind: NormalizedToolKind;
  /** Human-facing label. Adapters prefer a specific label over a generic one. */
  label: string;
  status: NormalizedToolStatus;
  /** Raw tool arguments/input (host- or backend-shaped). */
  args?: unknown;
  /** Raw tool result/output, present once completed. */
  result?: unknown;
  command?: NormalizedCommandDetail;
  fileDiff?: NormalizedFileDiff;
};

/** A partial tool-call delta. `id` is required so it can correlate to a prior tool_call. */
export type NormalizedToolCallUpdate = Partial<Omit<NormalizedToolCall, "id">> & {
  id: string;
};
