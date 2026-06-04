// The CANONICAL, backend-agnostic chat controller for agent-kit.
//
// Ties together a shared `AgentBackend` (one connection, many threads — Codex
// App Server OR an ACP agent, driven identically), an injected agent-core
// `ThreadStore` (thread index + per-turn journal + usage accounting), and a
// host-supplied tool catalog + prompt builders. It owns orchestration + the
// method surface (createThread / listThreads / rename / archive / sendMessage /
// getHistory / interrupt / resolveApproval / wire); the host owns storage and
// maps the controller's `ChatControllerEvent`s to its own IPC.
//
// Ported from PwrSnap's ChatThreadController with every product seam broken:
//   • persistence is the injected `ThreadStore` (no better-sqlite3, no
//     saveAiThreadUsage / estimateAiUsageCost import — the host computes cost in
//     its store impl via `recordUsage`);
//   • the backend is an `AgentBackend` (not a concrete CodexThreadClient), and
//     the controller subscribes via `backend.onEvent((e) => …)` switching on
//     `e.kind` instead of six granular per-event hooks;
//   • the catalog, `dispatchToolCall`, `buildSystemPrompt`, `buildTurnContext`,
//     and `broadcast` are all injected — no command bus, no PwrSnap tools or
//     typed event channels; `broadcast` takes a single neutral
//     `ChatControllerEvent`;
//   • `Settings` is generic (`TSettings`); the controller freezes a snapshot at
//     turn start and forwards it to the prompt builder, NEVER inspecting fields.
//
// Load-bearing design (preserved verbatim from PwrSnap):
//   • Per-thread TurnState in a Map, NEVER a singleton — two threads can stream
//     concurrently without cross-wiring.
//   • Settings are SNAPSHOTTED at turn start; a mid-turn change does not
//     retro-apply to the in-flight turn.
//   • Approvals carry (threadId, turnId, approvalId); a late / mismatched
//     resolution is rejected, never resolves the wrong turn.
//   • The host UI is a VIEW of this controller's state — all mutation flows out
//     via the `broadcast` seam.

import {
  noopLogger,
  type AgentBackend,
  type AgentBackendToolCall,
  type AgentStartThreadOptions,
  type AgentStartTurnOptions,
  type AgentTurnInput,
  type Logger,
  type NormalizedApprovalDecision,
  type NormalizedApprovalRequest,
  type NormalizedMessage,
  type NormalizedThreadEvent,
  type NormalizedThreadRecord,
  type NormalizedThreadStatus,
  type NormalizedThreadView,
  type NormalizedTokenUsage,
  type NormalizedToolCall,
  type NormalizedTurnStatus,
  type ThreadListOptions,
  type ThreadStore
} from "@pwrdrvr/agent-core";
import type {
  DynamicToolCallParams,
  DynamicToolCallResponse,
  DynamicToolSpec
} from "@pwrdrvr/codex-app-server-protocol/v2";

/** The backend the controller drives. Codex (`CodexThreadClient`) and ACP
 *  (`AcpAgentClient`) both implement the non-generic `AgentBackend`; the
 *  controller builds NEUTRAL thread/turn options, so any backend drops in
 *  identically with no per-backend branching. Retained as an alias to
 *  `AgentBackend` so existing hosts that name `ChatBackend` keep compiling. */
export type ChatBackend = AgentBackend;

/** Builds the per-thread system prompt (base + host guidance). Injected as
 *  `baseInstructions` at thread/start. Receives the frozen settings snapshot and
 *  the thread's anchor; the controller never inspects `TSettings`. */
export type ChatSystemPromptBuilder<TSettings = unknown> = (input: {
  settings: TSettings;
  anchorId: string | null;
}) => string;

/**
 * The neutral event union the controller broadcasts. The host maps these to its
 * own IPC. Surface-agnostic: a library-chat host and a sizzle-chat host map the
 * same union. Generalizes PwrSnap's six typed `events:*Chat:*` channels.
 */
export type ChatControllerEvent =
  | { type: "thread_updated"; thread: NormalizedThreadView }
  | { type: "stream_delta"; threadId: string; turnId: string; messageId: string; delta: string }
  | { type: "tool_call"; threadId: string; turnId: string; toolCall: NormalizedToolCall }
  | { type: "message_committed"; threadId: string; message: NormalizedMessage }
  | { type: "turn_interrupted"; threadId: string; turnId: string }
  | {
      type: "approval_requested";
      threadId: string;
      turnId: string;
      approval: NormalizedApprovalRequest;
    };

/** Re-broadcasts the controller's neutral event stream to the host's UI. */
export type ChatBroadcast = (event: ChatControllerEvent) => void;

/** Friendly present-tense labels for tool activity chips, keyed by tool name. */
export type ToolLabelMap = Record<string, string>;

export type ChatThreadControllerDeps<TSettings = unknown> = {
  /** The shared backend (Codex or ACP). */
  client: ChatBackend;
  /** Host persistence: thread index + per-turn journal + usage accounting. */
  store: ThreadStore;
  /** Reads the current host settings snapshot (frozen per turn). */
  readSettings: () => Promise<TSettings>;
  /** Re-broadcasts neutral controller events to the host UI. */
  broadcast: ChatBroadcast;
  /** Builds the per-thread system prompt. */
  buildSystemPrompt: ChatSystemPromptBuilder<TSettings>;
  /** Per-turn runtime context (L3), sent as a leading turn item framed as
   *  system-generated — never folded into the user's message. Receives the
   *  turn's anchor. Omit for no per-turn context. */
  buildTurnContext?: (anchor: string) => string;
  /** DynamicToolSpec[] registered on every thread/start. */
  catalog?: DynamicToolSpec[];
  /** Routes an incoming tool call to the host's tools. Defaults to a no-tools
   *  responder when omitted. */
  dispatchToolCall?: (params: DynamicToolCallParams) => Promise<DynamicToolCallResponse>;
  /** Friendly chip labels for tool activity. */
  toolLabels?: ToolLabelMap;
  /** Default-Access policy applied to every chat thread. */
  approvalPolicy?: string;
  sandbox?: string;
  /** Default serviceName for thread/start. */
  serviceName?: string;
  /** Per-thread Codex config overlay applied on every thread/start. */
  threadConfig?: Record<string, unknown>;
  /** Thread environments. `[]` disables exec-environment access. */
  threadEnvironments?: unknown[];
  /** Reasoning effort for turns. Defaults to "medium". */
  effort?: string;
  /** Default model id for thread/start (host's per-surface default). Omit for Codex default. */
  model?: string;
  /** Default model provider for thread/start — the "provider" a host picks when
   *  more than one is configured. Omit for Codex default. */
  modelProvider?: string;
  logger?: Logger;
  /** Injectable clock for tests. */
  now?: () => number;
};

/** Per-thread, in-flight turn state. */
type TurnState<TSettings> = {
  turnId: string;
  assistantMessageId: string;
  /** Accumulated streamed text for the in-flight assistant message. */
  buffer: string;
  /** Frozen at turn start — a mid-turn settings change can't retro-apply. */
  settingsSnapshot: TSettings;
  tokenUsage: NormalizedTokenUsage | null;
};

type ThreadModelState = {
  model: string | null;
  modelProvider: string | null;
  serviceTier: string | null;
};

/** A pending approval awaiting the host's decision. */
type PendingApproval = {
  threadId: string;
  turnId: string;
  approvalId: string;
  resolve: (decision: NormalizedApprovalDecision) => void;
};

/** One journal entry: a committed chat message. */
type JournalMessageEntry = { kind: "message"; message: NormalizedMessage };

const RATE_LIMIT_TURNS = 5;
const RATE_LIMIT_WINDOW_MS = 60_000;

export class ChatThreadController<TSettings = unknown> {
  private readonly deps: ChatThreadControllerDeps<TSettings>;
  private readonly logger: Logger;
  private readonly turns = new Map<string, TurnState<TSettings>>();
  private readonly pendingApprovals = new Map<string, PendingApproval>();
  /** Per-thread recent turn timestamps for rate limiting. */
  private readonly turnTimestamps = new Map<string, number[]>();
  private readonly threadModels = new Map<string, ThreadModelState>();
  private wired = false;

  constructor(deps: ChatThreadControllerDeps<TSettings>) {
    this.deps = deps;
    this.logger = deps.logger ?? noopLogger;
  }

  /** Wire the shared backend's subscription hooks ONCE. Idempotent. */
  wire(): void {
    if (this.wired) return;
    this.wired = true;
    const { client } = this.deps;
    client.onEvent((event) => this.onBackendEvent(event));
    client.onToolCall((call) => this.onToolCall(call));
    client.onApprovalRequest((method, params) => this.onApprovalRequest(method, params));
  }

  private now(): number {
    return this.deps.now ? this.deps.now() : Date.now();
  }

  // ---- thread lifecycle ----

  async createThread(
    opts: { name?: string; anchorId?: string | null } = {}
  ): Promise<NormalizedThreadView> {
    const anchorId = opts.anchorId ?? null;
    const settings = await this.deps.readSettings();
    const baseInstructions = this.deps.buildSystemPrompt({ settings, anchorId });
    const displayName =
      opts.name && opts.name.trim().length > 0 ? opts.name.trim() : this.defaultName();

    const preparedDir = await this.deps.store.prepareThreadDir(displayName);

    // NEUTRAL thread-open options. Every backend maps these onto its native
    // protocol internally — the controller never builds a Codex- or ACP-shaped
    // payload. `tools` is opaque (a Codex backend casts to DynamicToolSpec[];
    // ACP ignores it).
    const startOptions: AgentStartThreadOptions = {
      instructions: baseInstructions,
      cwd: preparedDir.path,
      workspaceRoots: [preparedDir.path]
    };
    if (this.deps.approvalPolicy !== undefined) startOptions.approvalPolicy = this.deps.approvalPolicy;
    if (this.deps.sandbox !== undefined) startOptions.sandbox = this.deps.sandbox;
    if (this.deps.model !== undefined) startOptions.model = this.deps.model;
    if (this.deps.modelProvider !== undefined) startOptions.modelProvider = this.deps.modelProvider;
    if (this.deps.serviceName !== undefined) startOptions.serviceName = this.deps.serviceName;
    if (this.deps.catalog !== undefined) startOptions.tools = this.deps.catalog;
    if (this.deps.threadConfig !== undefined) startOptions.config = this.deps.threadConfig;
    if (this.deps.threadEnvironments !== undefined) {
      startOptions.environments = this.deps.threadEnvironments;
    }

    let started: { threadId: string } & Partial<ThreadModelState>;
    try {
      started = await this.deps.client.startThread(startOptions);
    } catch (cause) {
      await this.deps.store.discardPreparedThreadDir(preparedDir).catch(() => undefined);
      throw cause;
    }

    await this.deps.client.clearThreadGitInfo?.(started.threadId).catch((cause) => {
      this.logger.warn("chat thread git metadata clear failed", {
        threadId: started.threadId,
        message: cause instanceof Error ? cause.message : String(cause)
      });
    });

    this.threadModels.set(started.threadId, {
      model: started.model ?? null,
      modelProvider: started.modelProvider ?? null,
      serviceTier: started.serviceTier ?? null
    });

    // Glue the thread to the subject it was started from. Null anchor = an
    // unscoped thread. The anchor is written in the SAME insert as the rest of
    // the row — one write, not create-then-update.
    const record = await this.deps.store.create({
      threadId: started.threadId,
      name: displayName,
      anchorId,
      preparedDir
    });
    const view = this.toView(record);
    this.deps.broadcast({ type: "thread_updated", thread: view });
    return view;
  }

  async listThreads(
    opts: { includeArchived?: boolean; anchorId?: string | null } = {}
  ): Promise<NormalizedThreadView[]> {
    // Filtering (archived + anchor scoping) is pushed into the store's indexed
    // query — no full scan in the controller. When an anchor is supplied the list
    // is scoped to that subject's threads; when omitted, every anchor is listed.
    const listOpts: ThreadListOptions = {
      includeArchived: opts.includeArchived ?? false,
      ...(opts.anchorId !== undefined ? { anchorId: opts.anchorId } : {})
    };
    const records = await this.deps.store.list(listOpts);
    return records.map((r) => this.toView(r));
  }

  async rename(threadId: string, name: string): Promise<NormalizedThreadView> {
    const record = await this.deps.store.update(threadId, { name: name.trim() });
    const view = this.toView(record);
    this.deps.broadcast({ type: "thread_updated", thread: view });
    return view;
  }

  async archive(threadId: string, archived: boolean): Promise<NormalizedThreadView> {
    const record = await this.deps.store.update(threadId, { archived });
    if (archived) await this.deps.client.archiveThread?.(threadId).catch(() => undefined);
    const view = this.toView(record);
    this.deps.broadcast({ type: "thread_updated", thread: view });
    return view;
  }

  // ---- turns ----

  async sendMessage(input: {
    threadId: string;
    text: string;
    anchorId?: string | null;
    /** Local image file paths to attach to this turn. Forwarded neutrally as
     *  `AgentTurnInput.imagePaths`; the backend maps to its native attachment
     *  (Codex `localImage`, ACP `image` blocks). */
    imagePaths?: readonly string[];
  }): Promise<{ turnId: string }> {
    const { threadId } = input;
    if (this.turns.has(threadId)) {
      throw new Error("a turn is already in progress for this thread");
    }
    this.enforceRateLimit(threadId);

    if (input.anchorId !== undefined && input.anchorId !== null) {
      await this.deps.store.appendAnchor(threadId, input.anchorId);
    }

    // Persist + broadcast the user message BEFORE starting the turn so a dispatch
    // failure doesn't lose the typed prompt.
    const userMessage: NormalizedMessage = {
      id: this.randomId(),
      role: "user",
      text: input.text,
      createdAt: this.now()
    };
    await this.commitMessage(threadId, userMessage);

    const settingsSnapshot = await this.deps.readSettings();

    // Per-turn active-context is prepended to the turn text as a leading,
    // explicitly system-framed block — separated from the user's text by a blank
    // line, NOT silently merged into the prose. It's emitted only for the CURRENT
    // turn (never accumulated) so the thread carries no stale context blocks, and
    // the static instructions stay byte-identical across turns so the backend can
    // prompt-cache them. The neutral `AgentTurnInput` carries a single text field,
    // so the context rides as a labeled preamble rather than a separate protocol
    // item.
    const anchorForTurn = input.anchorId ?? (await this.currentAnchor(threadId));
    let turnText = input.text;
    if (anchorForTurn !== null && this.deps.buildTurnContext !== undefined) {
      turnText = `${this.deps.buildTurnContext(anchorForTurn)}\n\n${input.text}`;
    }
    const turnInput: AgentTurnInput = { text: turnText };
    if (input.imagePaths !== undefined) turnInput.imagePaths = input.imagePaths;

    const startTurnOptions: AgentStartTurnOptions = {
      threadId,
      input: turnInput,
      reasoning: this.deps.effort ?? "medium"
    };

    let turnId: string;
    try {
      const started = await this.deps.client.startTurn(startTurnOptions);
      turnId = started.turnId;
    } catch (cause) {
      // Mark a placeholder assistant message failed so the UI shows Retry.
      const failed: NormalizedMessage = {
        id: this.randomId(),
        role: "assistant",
        text: "",
        createdAt: this.now()
      };
      await this.commitMessage(threadId, failed);
      this.logger.warn("chat turn start failed", {
        threadId,
        message: cause instanceof Error ? cause.message : String(cause)
      });
      throw cause;
    }

    const assistantMessageId = this.randomId();
    this.turns.set(threadId, {
      turnId,
      assistantMessageId,
      buffer: "",
      settingsSnapshot,
      tokenUsage: null
    });
    this.recordTurn(threadId);
    await this.broadcastThreadStatus(threadId, { kind: "streaming", turnId });
    return { turnId };
  }

  async getHistory(threadId: string): Promise<NormalizedMessage[]> {
    return this.readJournalMessages(threadId);
  }

  async interrupt(threadId: string): Promise<void> {
    const turn = this.turns.get(threadId);
    if (turn === undefined) return;
    await this.deps.client.interruptTurn(threadId).catch(() => undefined);
    await this.finalizeAssistant(threadId, "interrupted");
    this.deps.broadcast({ type: "turn_interrupted", threadId, turnId: turn.turnId });
  }

  // ---- approval flow ----

  async resolveApproval(input: {
    threadId: string;
    turnId: string;
    approvalId: string;
    decision: NormalizedApprovalDecision;
  }): Promise<void> {
    const key = approvalKey(input.threadId, input.turnId, input.approvalId);
    const pending = this.pendingApprovals.get(key);
    if (pending === undefined) {
      this.logger.warn("resolveApproval: no matching pending approval (stale?)", { key });
      return;
    }
    this.pendingApprovals.delete(key);
    pending.resolve(input.decision);
  }

  // ---- backend subscription handlers ----

  private onBackendEvent(event: NormalizedThreadEvent): void {
    switch (event.kind) {
      case "agent_message_delta":
        this.onDelta(event.threadId, event.turnId, event.itemId, event.delta);
        return;
      case "token_usage":
        this.onTokenUsage(event.threadId, event.turnId, event.usage);
        return;
      case "thread_settings":
        this.threadModels.set(event.settings.threadId, {
          model: event.settings.model ?? null,
          modelProvider: event.settings.modelProvider ?? null,
          serviceTier: event.settings.serviceTier ?? null
        });
        return;
      case "turn_completed":
        void this.onTurnCompleted(event.threadId, event.turnId, event.status);
        return;
      default:
        // reasoning_delta / agent_message / tool_call(_update) / plan_update /
        // turn_started / approval_request / error are handled via the dedicated
        // tool-call + approval seams or are informational; nothing to commit.
        return;
    }
  }

  private onDelta(threadId: string, turnId: string, itemId: string, delta: string): void {
    const turn = this.turns.get(threadId);
    if (turn === undefined || turn.turnId !== turnId) return;
    turn.buffer += delta;
    this.deps.broadcast({
      type: "stream_delta",
      threadId,
      turnId,
      messageId: turn.assistantMessageId,
      delta
    });
  }

  private async onTurnCompleted(
    threadId: string,
    turnId: string,
    status: NormalizedTurnStatus
  ): Promise<void> {
    const turn = this.turns.get(threadId);
    if (turn === undefined || turn.turnId !== turnId) return;
    await this.finalizeAssistant(threadId, status);
  }

  private onTokenUsage(threadId: string, turnId: string, usage: NormalizedTokenUsage): void {
    const turn = this.turns.get(threadId);
    if (turn === undefined || turn.turnId !== turnId) return;
    turn.tokenUsage = usage;
  }

  private async onToolCall(call: AgentBackendToolCall): Promise<unknown> {
    const params = call.params as DynamicToolCallParams;
    const response = this.deps.dispatchToolCall
      ? await this.deps.dispatchToolCall(params)
      : ({
          contentItems: [{ type: "inputText", text: "No tools are enabled for this chat yet." }],
          success: false
        } satisfies DynamicToolCallResponse);
    // Surface the tool invocation to the chat UI as it happens (the activity chip
    // + working indicator). Re-broadcast as a neutral `tool_call` event carrying
    // the call's terminal status + a friendly label.
    this.deps.broadcast({
      type: "tool_call",
      threadId: params.threadId,
      turnId: params.turnId,
      toolCall: {
        id: params.callId,
        name: params.tool,
        kind: "other",
        label: humanizeToolCall(params.tool, response.success, this.deps.toolLabels),
        status: response.success ? "completed" : "failed",
        args: params.arguments,
        result: response
      }
    });
    return response;
  }

  private async onApprovalRequest(
    method: string,
    params: unknown
  ): Promise<NormalizedApprovalDecision> {
    // Best-effort extraction of (threadId, turnId); backend shapes vary by method.
    const p = (params ?? {}) as Record<string, unknown>;
    let threadId = typeof p.threadId === "string" ? p.threadId : "";
    let turnId = typeof p.turnId === "string" ? p.turnId : "";

    // The backend doesn't always tag an approval with its (threadId, turnId).
    // Without a threadId the host can't match the approval to a visible thread, so
    // the promise below would never resolve and the turn would hang. Recover the
    // only-possible thread when exactly one turn is in flight; otherwise auto-DENY
    // (Default Access never auto-APPROVES) with a warning rather than deadlocking.
    if (threadId.length === 0) {
      const onlyEntry = this.turns.size === 1 ? [...this.turns.entries()][0] : undefined;
      if (onlyEntry !== undefined) {
        const [onlyThreadId, onlyTurn] = onlyEntry;
        threadId = onlyThreadId;
        if (turnId.length === 0) turnId = onlyTurn.turnId;
      } else {
        this.logger.warn("approval request without a routable threadId — auto-denying", {
          method,
          inFlightTurns: this.turns.size
        });
        return "denied";
      }
    }

    const approvalId = this.randomId();
    const request: NormalizedApprovalRequest = normalizeApprovalParams(method, params, approvalId);

    const decision = await new Promise<NormalizedApprovalDecision>((resolve) => {
      this.pendingApprovals.set(approvalKey(threadId, turnId, approvalId), {
        threadId,
        turnId,
        approvalId,
        resolve
      });
      this.deps.broadcast({ type: "approval_requested", threadId, turnId, approval: request });
      void this.broadcastThreadStatus(threadId, { kind: "awaiting_approval", approvalId });
    });

    const turn = this.turns.get(threadId);
    void this.broadcastThreadStatus(
      threadId,
      turn ? { kind: "streaming", turnId: turn.turnId } : { kind: "idle" }
    );
    return decision;
  }

  // ---- internals ----

  private async finalizeAssistant(
    threadId: string,
    status: NormalizedTurnStatus
  ): Promise<void> {
    const turn = this.turns.get(threadId);
    if (turn === undefined) return;
    this.turns.delete(threadId);

    const message: NormalizedMessage = {
      id: turn.assistantMessageId,
      role: "assistant",
      text: turn.buffer,
      createdAt: this.now()
    };

    this.recordUsage(threadId, turn).catch((cause) => {
      this.logger.warn("chat usage accounting failed", {
        threadId,
        turnId: turn.turnId,
        message: cause instanceof Error ? cause.message : String(cause)
      });
    });

    await this.commitMessage(threadId, message);
    await this.broadcastThreadStatus(threadId, { kind: "idle" });
  }

  private async recordUsage(threadId: string, turn: TurnState<TSettings>): Promise<void> {
    if (turn.tokenUsage === null) return;
    const model = this.threadModels.get(threadId);
    const usage = turn.tokenUsage;
    await this.deps.store.recordUsage({
      threadId,
      turnId: turn.turnId,
      ...(model?.model != null ? { model: model.model } : {}),
      usage,
      ...(usage.contextWindow !== undefined ? { contextWindow: usage.contextWindow } : {}),
      at: this.now()
    });
  }

  private async commitMessage(threadId: string, message: NormalizedMessage): Promise<void> {
    const entry: JournalMessageEntry = { kind: "message", message };
    await this.deps.store.journalAppend(threadId, entry);
    this.deps.broadcast({ type: "message_committed", threadId, message });
  }

  private async readJournalMessages(threadId: string): Promise<NormalizedMessage[]> {
    const entries = await this.deps.store.readJournal(threadId).catch(() => [] as unknown[]);
    const messages: NormalizedMessage[] = [];
    for (const entry of entries) {
      if (
        entry !== null &&
        typeof entry === "object" &&
        (entry as { kind?: unknown }).kind === "message"
      ) {
        const m = (entry as { message?: unknown }).message;
        if (m !== undefined) messages.push(m as NormalizedMessage);
      }
    }
    return messages;
  }

  private async currentAnchor(threadId: string): Promise<string | null> {
    const record = await this.deps.store.get(threadId);
    return record?.anchorId ?? null;
  }

  private enforceRateLimit(threadId: string): void {
    const stamps = this.turnTimestamps.get(threadId) ?? [];
    const cutoff = this.now() - RATE_LIMIT_WINDOW_MS;
    const recent = stamps.filter((t) => t >= cutoff);
    if (recent.length >= RATE_LIMIT_TURNS) {
      throw new Error(`rate limit: max ${RATE_LIMIT_TURNS} turns per minute for this thread`);
    }
  }

  private recordTurn(threadId: string): void {
    const stamps = this.turnTimestamps.get(threadId) ?? [];
    const cutoff = this.now() - RATE_LIMIT_WINDOW_MS;
    const recent = stamps.filter((t) => t >= cutoff);
    recent.push(this.now());
    this.turnTimestamps.set(threadId, recent);
  }

  private async broadcastThreadStatus(
    threadId: string,
    status: NormalizedThreadStatus
  ): Promise<void> {
    const record = await this.deps.store.get(threadId);
    if (record === null) return;
    this.deps.broadcast({ type: "thread_updated", thread: this.toView(record, status) });
  }

  private toView(
    record: NormalizedThreadRecord,
    status?: NormalizedThreadStatus
  ): NormalizedThreadView {
    const turn = this.turns.get(record.threadId);
    const resolved: NormalizedThreadStatus =
      status ?? (turn !== undefined ? { kind: "streaming", turnId: turn.turnId } : { kind: "idle" });
    return {
      threadId: record.threadId,
      name: record.name,
      createdAt: record.createdAt,
      modifiedAt: record.modifiedAt,
      anchorId: record.anchorId,
      archived: record.archived,
      pinned: record.pinned,
      lastMessagePreview: "",
      status: resolved
    };
  }

  private defaultName(): string {
    return `Chat ${localDateStamp(new Date(this.now()))}`;
  }

  private randomId(): string {
    return globalThis.crypto.randomUUID();
  }
}

/** Local-timezone `YYYY-MM-DD` stamp (NOT `toISOString()`, which is UTC). */
export function localDateStamp(d: Date): string {
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function approvalKey(threadId: string, turnId: string, approvalId: string): string {
  return `${threadId}::${turnId}::${approvalId}`;
}

/** Friendly present-tense label for a tool invocation, shown as an activity chip.
 *  The host supplies the label map; falls back to the raw tool name. The `ok` flag
 *  lets a failed call read "couldn't …". */
function humanizeToolCall(tool: string, ok: boolean, labels: ToolLabelMap = {}): string {
  const label = labels[tool] ?? tool;
  return ok ? label : `Couldn't: ${label.toLowerCase()}`;
}

function normalizeApprovalParams(
  method: string,
  params: unknown,
  approvalId: string
): NormalizedApprovalRequest {
  const p = (params ?? {}) as Record<string, unknown>;
  const summary =
    typeof p.summary === "string"
      ? p.summary
      : typeof p.reason === "string"
        ? p.reason
        : typeof p.command === "string"
          ? p.command
          : undefined;
  const kind = method.includes("commandExecution")
    ? "exec"
    : method.includes("fileChange")
      ? "patch"
      : method.includes("tool")
        ? "tool"
        : "other";
  const request: NormalizedApprovalRequest = { id: approvalId, method, kind, params };
  if (summary !== undefined) request.summary = summary;
  return request;
}
