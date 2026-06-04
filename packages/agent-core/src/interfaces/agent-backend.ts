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

/**
 * Neutral, protocol-free options for opening a thread on ANY backend. The
 * canonical `ChatThreadController` builds these; each adapter maps them onto its
 * native shape (`CodexThreadClient` → Codex `ThreadStartParams`, `AcpAgentClient`
 * → ACP `session/new`). Fields a backend doesn't understand are ignored by that
 * adapter — agent-core never references a protocol type.
 */
export type AgentStartThreadOptions = {
  /** System / base instructions for the thread (Codex `baseInstructions`). */
  instructions?: string;
  /** Working directory for the thread/session. */
  cwd?: string;
  /** Workspace roots the backend may operate within. */
  workspaceRoots?: string[];
  /** Model id to start the thread on. Omit for the backend default. */
  model?: string;
  /** Model provider id (the "provider" a host picks when more than one exists). */
  modelProvider?: string;
  /** Service tier, when the host pins one. `null` = explicitly unset. */
  serviceTier?: string | null;
  /** Approval policy token (backend-specific vocabulary, passed through as-is). */
  approvalPolicy?: string;
  /** Sandbox mode token (backend-specific vocabulary, passed through as-is). */
  sandbox?: string;
  /** A client/service identity sent at thread/start, when the backend supports it. */
  serviceName?: string;
  /** Per-thread backend config overlay (Codex `-c key=value`). Ignored by ACP. */
  config?: Record<string, unknown>;
  /** Backend exec-environment descriptors. Ignored by ACP. */
  environments?: unknown[];
  /**
   * OPAQUE tool catalog. agent-core stays protocol-free: a Codex backend casts
   * this to `DynamicToolSpec[]`; ACP ignores it. Never inspected here.
   */
  tools?: unknown[];
};

/** Neutral options for forking an existing thread into a fresh one (Codex
 *  `thread/fork`). Same shape as starting a thread, plus the source thread id. */
export type AgentForkThreadOptions = AgentStartThreadOptions & {
  sourceThreadId: string;
};

/** Neutral turn content. Text plus optional local image paths the backend may
 *  attach (Codex `localImage`, ACP `image` content blocks). */
export type AgentTurnInput = {
  text: string;
  imagePaths?: readonly string[];
};

/** Neutral options for starting a turn on ANY backend. */
export type AgentStartTurnOptions = {
  threadId: string;
  input: AgentTurnInput;
  /** Reasoning effort / mode token (backend-specific vocabulary). */
  reasoning?: string;
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
 * (`onToolCall`/`onApprovalRequest`). NON-generic: every backend takes the SAME
 * neutral `AgentStartThreadOptions`/`AgentStartTurnOptions` and maps them onto
 * its native protocol internally, so the controller drives Codex and ACP
 * identically without ever branching per backend.
 */
export interface AgentBackend {
  /** Open a thread (Codex `thread/start`, ACP `session/new`). */
  startThread(options?: AgentStartThreadOptions): Promise<AgentBackendStartThreadResult>;
  /** Start a turn (Codex `turn/start`, ACP `session/prompt`). */
  startTurn(options: AgentStartTurnOptions): Promise<{ turnId: string }>;
  /** Interrupt / cancel the in-flight turn for a thread. */
  interruptTurn(threadId: string): Promise<void>;
  /** Fork an existing thread into a fresh one carrying its history (Codex
   *  `thread/fork`). Optional: a backend without server-side fork (ACP) omits
   *  it, and the controller's `forkThreadsForAnchor` throws if called. */
  forkThread?(options: AgentForkThreadOptions): Promise<AgentBackendStartThreadResult>;
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
