// Neutral approval-request shape. A backend that asks the user to approve an
// action (Codex App Server ServerRequest, ACP session/request_permission)
// surfaces it as this; the host renders it and answers with a decision.

export type NormalizedApprovalKind = "exec" | "patch" | "tool" | "other";

export type NormalizedApprovalRequest = {
  /** Correlation id the host echoes back when answering. */
  id: string;
  /** Raw backend method (e.g. an App Server ServerRequest method) for routing/debugging. */
  method: string;
  kind: NormalizedApprovalKind;
  /** Short human-facing summary of what is being approved, when the adapter can derive one. */
  summary?: string;
  /** Raw params for the host to render and decide on. */
  params: unknown;
};

export type NormalizedApprovalDecision = "approved" | "denied" | "abort";
