// The minimal seam a surface-agnostic chat controller needs to drive ANY
// backend (Codex App Server, ACP agents) identically. Both `CodexThreadClient`
// (the Codex adapter) and `AcpAgentClient` (the ACP adapter) implement this, so
// the controller holds an `AgentBackend` and never branches per backend
// (`if (isAcp) …`). This is the U23 polymorphism seam.
//
// Shapes mirror `CodexThreadClient`'s public surface so the two converge
// without either adapter contorting: a long-lived connection that opens
// threads, runs turns, streams `NormalizedThreadEvent`s, and routes
// tool-call / approval server-requests through injected handlers.

import type { NormalizedThreadEvent } from "../schema/thread-events";
import type { NormalizedApprovalDecision } from "../schema/approval";

export type Unsubscribe = () => void;

/** Result of opening a thread on a backend. Optional fields a backend may not know. */
export type AgentBackendStartThreadResult = {
  threadId: string;
  model?: string;
  modelProvider?: string;
  serviceTier?: string | null;
};

/** A backend tool-call server-request, surfaced to the host for dispatch. */
export type AgentBackendToolCall = {
  /** Backend method the call arrived on (for routing/debugging). */
  method: string;
  /** Raw, backend-shaped tool params. The host's catalog dispatches on these. */
  params: unknown;
};

/** The host's tool-call handler; returns a backend-shaped response payload. */
export type AgentBackendToolCallHandler = (
  call: AgentBackendToolCall
) => Promise<unknown>;

/** The host's approval handler; resolves to a neutral decision the backend maps back. */
export type AgentBackendApprovalHandler = (
  method: string,
  params: unknown
) => Promise<NormalizedApprovalDecision>;

/**
 * The minimal backend interface a chat controller depends on. Intentionally
 * narrow: lifecycle (`startThread`/`startTurn`/`interruptTurn`/`close`),
 * a normalized event stream (`onEvent`), and the two server-request seams
 * (`onToolCall`/`onApprovalRequest`). Backend-specific options are passed via
 * the generic `StartThreadOptions`/`StartTurnOptions` so the controller stays
 * neutral while a host can still pass through per-backend knobs.
 */
export interface AgentBackend<
  StartThreadOptions = unknown,
  StartTurnOptions = unknown
> {
  /** Open a thread (Codex `thread/start`, ACP `session/new`). */
  startThread(options?: StartThreadOptions): Promise<AgentBackendStartThreadResult>;
  /** Start a turn (Codex `turn/start`, ACP `session/prompt`). */
  startTurn(options: StartTurnOptions): Promise<{ turnId: string }>;
  /** Interrupt / cancel the in-flight turn for a thread. */
  interruptTurn(threadId: string): Promise<void>;
  /** Archive a thread on the backend, when it has the concept. Optional: a
   *  backend without server-side archive (the controller still archives the
   *  index row via the `ThreadStore`) simply omits it. */
  archiveThread?(threadId: string): Promise<void>;
  /** Clear backend-side git metadata for a freshly-opened thread, when the
   *  backend tracks it (Codex stamps the cwd's git info onto the thread; chat
   *  threads in a scratch dir shouldn't carry it). Optional. */
  clearThreadGitInfo?(threadId: string): Promise<void>;
  /** Subscribe to the normalized event stream. */
  onEvent(cb: (event: NormalizedThreadEvent) => void): Unsubscribe;
  /** Register the (single) tool-call server-request handler. */
  onToolCall(handler: AgentBackendToolCallHandler): Unsubscribe;
  /** Register the (single) approval server-request handler. */
  onApprovalRequest(handler: AgentBackendApprovalHandler): Unsubscribe;
  /** Tear down the connection / child process. */
  close(): Promise<void>;
}
