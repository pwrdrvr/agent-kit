// Surface-agnostic chat controller over a CodexThreadClient.
//
// Ties together a shared CodexThreadClient (one connection, many threads), an
// injected agent-core ThreadStore (persistence + usage), and a host-supplied
// tool catalog + prompt builders. It owns the per-turn lifecycle: snapshot
// settings at turn start, stream deltas, route tool calls, account usage,
// gate approvals, rate-limit.
//
// Ported from PwrSnap's ChatThreadController with the product seams broken:
//   • persistence is the injected `ThreadStore` (no better-sqlite3, no
//     saveAiThreadUsage import);
//   • the catalog, `dispatchToolCall`, `buildSystemPrompt`, `buildTurnContext`,
//     and `broadcast` are all injected — no command bus, no PwrSnap tools or
//     event channels;
//   • subscribers receive agent-core `NormalizedThreadEvent`s (the controller
//     re-broadcasts the client's normalized stream plus its own
//     turn_started / agent_message / turn_completed / approval events). It must
//     work unchanged for a "library chat" or a "sizzle chat" host.
//
// Load-bearing design:
//   • Per-thread TurnState in a Map, NEVER a singleton — two threads can stream
//     concurrently without cross-wiring.
//   • Settings are SNAPSHOTTED at turn start; a mid-turn change does not
//     retro-apply to the in-flight turn.
//   • Approvals carry (threadId, turnId, approvalId); a late / mismatched
//     resolution is rejected, never resolves the wrong turn.

import {
  mergeToolCall,
  noopLogger,
  type Logger,
  type NormalizedApprovalDecision,
  type NormalizedApprovalRequest,
  type NormalizedMessage,
  type NormalizedThread,
  type NormalizedThreadEntry,
  type NormalizedThreadEvent,
  type NormalizedTokenUsage,
  type NormalizedToolCall,
  type NormalizedTurnStatus,
  type ThreadStore
} from "@pwrdrvr/agent-core";
import type {
  DynamicToolCallParams,
  DynamicToolCallResponse,
  DynamicToolSpec,
  UserInput
} from "@pwrdrvr/codex-app-server-protocol/v2";
import type { CodexThreadClient } from "../codex-thread-client";

/** Generic settings snapshot. The host shapes this; the controller only freezes
 *  and forwards it to the prompt builder, never inspects it. */
export type ChatSettingsSnapshot = unknown;

/** Builds the per-thread system prompt (base + host guidance). Injected as
 *  `baseInstructions` at thread/start. */
export type ChatSystemPromptBuilder = (input: {
  settings: ChatSettingsSnapshot;
  anchorId: string | null;
}) => string;

/** Re-broadcasts the controller's normalized event stream to the host's UI.
 *  Surface-agnostic: a library-chat host and a sizzle-chat host pass their own. */
export type ChatBroadcast = (event: NormalizedThreadEvent) => void;

/** Friendly present-tense labels for tool activity chips, keyed by tool name. */
export type ToolLabelMap = Record<string, string>;

export type ChatThreadControllerDeps = {
  client: CodexThreadClient;
  store: ThreadStore;
  /** Reads the current host settings snapshot (frozen per turn). */
  readSettings: () => Promise<ChatSettingsSnapshot>;
  /** Re-broadcasts normalized events to the host UI. */
  broadcast: ChatBroadcast;
  buildSystemPrompt: ChatSystemPromptBuilder;
  /** Per-turn runtime context (L3), sent as a leading turn item framed as
   *  system-generated — never folded into the user's message. Receives the
   *  turn's anchor. Omit for no per-turn context. */
  buildTurnContext?: (anchor: string) => string;
  /** DynamicToolSpec[] registered on every thread/start. */
  catalog?: DynamicToolSpec[];
  /** Routes an incoming item/tool/call to the host's tools. Defaults to a
   *  no-tools responder when omitted. */
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
  /** Model attribution recorded with usage; the controller fills it from
   *  thread_settings events when Codex reports them. */
  logger?: Logger;
  /** Injectable clock for tests. */
  now?: () => number;
};

/** Per-thread, in-flight turn state. */
type TurnState = {
  turnId: string;
  assistantMessageId: string;
  /** Accumulated streamed text for the in-flight assistant message. */
  buffer: string;
  /** Frozen at turn start — a mid-turn settings change can't retro-apply. */
  settingsSnapshot: ChatSettingsSnapshot;
  tokenUsage: NormalizedTokenUsage | null;
  /** Live tool calls keyed by id (merged across tool_call → tool_call_update). */
  toolCalls: Map<string, NormalizedToolCall>;
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

export type ChatThreadView = {
  threadId: string;
  name: string;
  anchorId: string | null;
  model: string | null;
  modelProvider: string | null;
  serviceTier: string | null;
};

const RATE_LIMIT_TURNS = 5;
const RATE_LIMIT_WINDOW_MS = 60_000;

export class ChatThreadController {
  private readonly deps: ChatThreadControllerDeps;
  private readonly logger: Logger;
  private readonly turns = new Map<string, TurnState>();
  private readonly pendingApprovals = new Map<string, PendingApproval>();
  /** Per-thread recent turn timestamps for rate limiting. */
  private readonly turnTimestamps = new Map<string, number[]>();
  private readonly threadModels = new Map<string, ThreadModelState>();
  /** Materialized transcript per thread (committed messages). */
  private readonly transcripts = new Map<string, NormalizedMessage[]>();
  private readonly threadNames = new Map<string, string>();
  private readonly threadAnchors = new Map<string, string | null>();
  private wired = false;

  constructor(deps: ChatThreadControllerDeps) {
    this.deps = deps;
    this.logger = deps.logger ?? noopLogger;
  }

  /** Wire the shared client's subscription hooks ONCE. Idempotent. */
  wire(): void {
    if (this.wired) return;
    this.wired = true;
    const { client } = this.deps;
    client.onEvent((event) => this.onClientEvent(event));
    client.onToolCall((params) => this.onToolCall(params));
    client.onApprovalRequest((method, params) => this.onApprovalRequest(method, params));
  }

  private now(): number {
    return this.deps.now ? this.deps.now() : Date.now();
  }

  // ---- thread lifecycle ----

  async createThread(
    opts: { name?: string; anchorId?: string | null } = {}
  ): Promise<ChatThreadView> {
    const anchorId = opts.anchorId ?? null;
    const settings = await this.deps.readSettings();
    const baseInstructions = this.deps.buildSystemPrompt({ settings, anchorId });
    const displayName =
      opts.name && opts.name.trim().length > 0 ? opts.name.trim() : this.defaultName();

    const started = await this.deps.client.startThread({
      ...(this.deps.approvalPolicy !== undefined ? { approvalPolicy: this.deps.approvalPolicy } : {}),
      ...(this.deps.sandbox !== undefined ? { sandbox: this.deps.sandbox } : {}),
      baseInstructions,
      ...(this.deps.serviceName !== undefined ? { serviceName: this.deps.serviceName } : {}),
      ...(this.deps.catalog !== undefined ? { dynamicTools: this.deps.catalog } : {}),
      ...(this.deps.threadConfig !== undefined ? { config: this.deps.threadConfig } : {}),
      ...(this.deps.threadEnvironments !== undefined
        ? { environments: this.deps.threadEnvironments }
        : {})
    });

    await this.deps.client.clearThreadGitInfo(started.threadId).catch((cause) => {
      this.logger.warn("chat thread git metadata clear failed", {
        threadId: started.threadId,
        message: cause instanceof Error ? cause.message : String(cause)
      });
    });

    this.threadModels.set(started.threadId, {
      model: started.model,
      modelProvider: started.modelProvider,
      serviceTier: started.serviceTier
    });
    this.threadNames.set(started.threadId, displayName);
    this.threadAnchors.set(started.threadId, anchorId);
    this.transcripts.set(started.threadId, []);

    await this.persistThread(started.threadId);
    return this.toView(started.threadId);
  }

  // ---- turns ----

  async sendMessage(input: {
    threadId: string;
    text: string;
    anchorId?: string | null;
  }): Promise<{ turnId: string }> {
    const { threadId } = input;
    if (this.turns.has(threadId)) {
      throw new Error("a turn is already in progress for this thread");
    }
    this.enforceRateLimit(threadId);

    if (input.anchorId !== undefined) {
      this.threadAnchors.set(threadId, input.anchorId);
    }

    // Persist + broadcast the user message BEFORE starting the turn so a
    // dispatch failure doesn't lose the typed prompt.
    const userMessage: NormalizedMessage = {
      id: this.randomId(),
      role: "user",
      text: input.text,
      createdAt: this.now()
    };
    await this.commitMessage(threadId, userMessage);

    const settingsSnapshot = await this.deps.readSettings();

    // Per-turn active-context goes in a SEPARATE leading turn item, explicitly
    // framed as system-generated and NOT folded into the user's text. It's
    // emitted only for the CURRENT turn (never accumulated) so the thread carries
    // no stale context blocks, and the static baseInstructions stays byte-
    // identical across turns so Codex can prompt-cache it.
    const anchorForTurn = input.anchorId ?? this.threadAnchors.get(threadId) ?? null;
    const turnInput: UserInput[] = [];
    if (anchorForTurn !== null && this.deps.buildTurnContext !== undefined) {
      turnInput.push({
        type: "text",
        text: this.deps.buildTurnContext(anchorForTurn),
        text_elements: []
      });
    }
    turnInput.push({ type: "text", text: input.text, text_elements: [] });

    let turnId: string;
    try {
      const started = await this.deps.client.startTurn({
        threadId,
        input: turnInput,
        effort: this.deps.effort ?? "medium"
      });
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
      this.broadcast({
        kind: "turn_completed",
        threadId,
        turnId: "",
        status: "failed"
      });
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
      tokenUsage: null,
      toolCalls: new Map()
    });
    this.recordTurn(threadId);
    this.broadcast({ kind: "turn_started", threadId, turnId });
    return { turnId };
  }

  async getHistory(threadId: string): Promise<NormalizedMessage[]> {
    return [...(this.transcripts.get(threadId) ?? [])];
  }

  async interrupt(threadId: string): Promise<void> {
    const turn = this.turns.get(threadId);
    if (turn === undefined) return;
    await this.deps.client.interruptTurn(threadId).catch(() => undefined);
    await this.finalizeAssistant(threadId, "interrupted");
  }

  async archive(threadId: string): Promise<void> {
    await this.deps.client.archiveThread(threadId).catch(() => undefined);
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

  // ---- client subscription handlers ----

  private onClientEvent(event: NormalizedThreadEvent): void {
    switch (event.kind) {
      case "agent_message_delta":
        this.onDelta(event.threadId, event.turnId, event.itemId, event.delta);
        return;
      case "reasoning_delta":
        // Reasoning deltas are re-broadcast for the in-flight turn but not
        // accumulated into the committed assistant message.
        if (this.isCurrentTurn(event.threadId, event.turnId)) this.broadcast(event);
        return;
      case "tool_call":
      case "tool_call_update":
        this.onToolCallEvent(event);
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
        this.broadcast(event);
        return;
      case "agent_message":
        // The final assistant message is committed at turn_completed from the
        // accumulated buffer; the streamed `agent_message` is informational.
        if (this.isCurrentTurn(event.threadId, event.turnId)) this.broadcast(event);
        return;
      case "turn_completed":
        void this.onTurnCompleted(event.threadId, event.turnId, event.status);
        return;
      case "turn_started":
      case "error":
        this.broadcast(event);
        return;
      default:
        return;
    }
  }

  private isCurrentTurn(threadId: string, turnId: string): boolean {
    const turn = this.turns.get(threadId);
    return turn !== undefined && turn.turnId === turnId;
  }

  private onDelta(threadId: string, turnId: string, itemId: string, delta: string): void {
    const turn = this.turns.get(threadId);
    if (turn === undefined || turn.turnId !== turnId) return;
    turn.buffer += delta;
    this.broadcast({ kind: "agent_message_delta", threadId, turnId, itemId, delta });
  }

  private onToolCallEvent(
    event: Extract<NormalizedThreadEvent, { kind: "tool_call" | "tool_call_update" }>
  ): void {
    const turn = this.turns.get(event.threadId);
    if (turn === undefined || turn.turnId !== event.turnId) return;
    if (event.kind === "tool_call") {
      turn.toolCalls.set(event.toolCall.id, event.toolCall);
    } else {
      const prev = turn.toolCalls.get(event.toolCall.id);
      if (prev !== undefined) {
        turn.toolCalls.set(event.toolCall.id, mergeToolCall(prev, event.toolCall));
      }
    }
    this.broadcast(event);
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

  private async onToolCall(params: DynamicToolCallParams): Promise<DynamicToolCallResponse> {
    const response = this.deps.dispatchToolCall
      ? await this.deps.dispatchToolCall(params)
      : ({
          contentItems: [{ type: "inputText", text: "No tools are enabled for this chat yet." }],
          success: false
        } satisfies DynamicToolCallResponse);
    // Surface the tool invocation to the UI as it happens. Re-broadcast as a
    // normalized tool_call_update carrying the call's terminal status.
    this.broadcast({
      kind: "tool_call_update",
      threadId: params.threadId,
      turnId: params.turnId,
      toolCall: {
        id: params.callId,
        status: response.success ? "completed" : "failed",
        label: this.deps.toolLabels?.[params.tool] ?? params.tool
      }
    });
    return response;
  }

  private async onApprovalRequest(
    method: string,
    params: unknown
  ): Promise<NormalizedApprovalDecision> {
    // Best-effort extraction of (threadId, turnId); Codex shapes vary by method.
    const p = (params ?? {}) as Record<string, unknown>;
    let threadId = typeof p.threadId === "string" ? p.threadId : "";
    let turnId = typeof p.turnId === "string" ? p.turnId : "";

    // Codex doesn't always tag an approval with its (threadId, turnId). Without
    // a threadId the host can't match the approval to a thread, so the promise
    // below would never resolve and the turn would hang. Recover the only-
    // possible thread when exactly one turn is in flight; otherwise auto-DENY.
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
      this.broadcast({
        kind: "approval_request",
        threadId,
        ...(turnId.length > 0 ? { turnId } : {}),
        approval: request
      });
    });
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
    this.broadcast({ kind: "turn_completed", threadId, turnId: turn.turnId, status });
  }

  private async recordUsage(threadId: string, turn: TurnState): Promise<void> {
    if (turn.tokenUsage === null) return;
    const model = this.threadModels.get(threadId);
    await this.deps.store.recordUsage({
      threadId,
      turnId: turn.turnId,
      ...(model?.model != null ? { model: model.model } : {}),
      usage: turn.tokenUsage,
      at: this.now()
    });
  }

  private async commitMessage(threadId: string, message: NormalizedMessage): Promise<void> {
    const transcript = this.transcripts.get(threadId) ?? [];
    transcript.push(message);
    this.transcripts.set(threadId, transcript);
    await this.persistThread(threadId);
    this.broadcast({
      kind: "agent_message",
      threadId,
      turnId: this.turns.get(threadId)?.turnId ?? "",
      message
    });
  }

  private async persistThread(threadId: string): Promise<void> {
    await this.deps.store.saveThread(this.materializeThread(threadId));
  }

  private materializeThread(threadId: string): NormalizedThread {
    const messages = [...(this.transcripts.get(threadId) ?? [])];
    const entries: NormalizedThreadEntry[] = messages.map((m) => ({ ...m, type: "message" }));
    const lastUser = [...messages].reverse().find((m) => m.role === "user");
    const lastAssistant = [...messages].reverse().find((m) => m.role === "assistant");
    const thread: NormalizedThread = {
      id: threadId,
      entries,
      messages,
      status: this.turns.has(threadId) ? "active" : "idle"
    };
    if (lastUser !== undefined) thread.lastUserMessage = lastUser.text;
    if (lastAssistant !== undefined) thread.lastAssistantMessage = lastAssistant.text;
    return thread;
  }

  private broadcast(event: NormalizedThreadEvent): void {
    this.deps.broadcast(event);
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

  private toView(threadId: string): ChatThreadView {
    const model = this.threadModels.get(threadId) ?? {
      model: null,
      modelProvider: null,
      serviceTier: null
    };
    return {
      threadId,
      name: this.threadNames.get(threadId) ?? "",
      anchorId: this.threadAnchors.get(threadId) ?? null,
      model: model.model,
      modelProvider: model.modelProvider,
      serviceTier: model.serviceTier
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
