// Long-lived ACP client. Speaks ACP over the stdio transport and normalizes the
// agent's `session/update` stream into agent-core `NormalizedThreadEvent` — the
// same shapes CodexThreadClient emits, so the two unify behind `AgentBackend`.
//
// PUBLIC SURFACE mirrors CodexThreadClient on purpose:
//   startThread / startTurn / interruptTurn / onEvent / onToolCall /
//   onApprovalRequest / close.
//
// Ported from PwrAgnt acp-client.ts, with all app concerns stripped (SQLite
// session/rollout stores, live-notifications, DesktopBackendRegistry). Per-
// session state the normalizer needs is held IN-MEMORY here; persistence is the
// host's job (agent-core ThreadStore).
//
// Per-agent quirks (suppress thoughts, title source, vendor notification
// methods) come from the registered STRATEGY — never an inline agent-id branch.

import {
  noopLogger,
  type AgentBackend,
  type AgentBackendApprovalHandler,
  type AgentBackendStartThreadResult,
  type AgentBackendToolCall,
  type AgentBackendToolCallHandler,
  type Logger,
  type NormalizedApprovalDecision,
  type NormalizedApprovalRequest,
  type NormalizedThreadEvent,
  type NormalizedThreadSettings,
  type Unsubscribe
} from "@pwrdrvr/agent-core";
import type { JsonRpcId } from "@pwrdrvr/agent-transport";
import type { AcpAgentStrategy } from "./strategies/strategy-types";
import {
  AcpSessionNormalizer,
  type AcpApplyContext
} from "./normalizer/acp-normalizer";
import {
  acpRuntimeSupportsSessionLoad,
  acpSessionRuntimeStateFromCapabilities,
  acpSessionRuntimeStateFromUpdate,
  mergeAcpRuntimeState,
  modeLabelFor,
  normalizeAcpRuntimeCapabilities,
  type AcpRuntimeCapabilities,
  type AcpSessionRuntimeState
} from "./normalizer/runtime-capabilities";
import type { AcpJsonRpcTransport } from "./acp-stdio-transport";

const ACP_PROTOCOL_VERSION = 1;
const ACP_PROMPT_REQUEST_TIMEOUT_MS = 60 * 60_000;
const ACP_REQUEST_TIMEOUT_MS = 30_000;

export type AcpPromptContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; mimeType: string; data: string };

export type AcpMcpServerConfig = {
  name: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
};

export type AcpRuntimeOptionSource = "mode" | "model" | "configOption";

export type AcpAgentClientOptions = {
  /** The transport (real stdio or a fake). */
  transport: AcpJsonRpcTransport;
  /** The agent strategy (carries quirks + display name). */
  strategy: AcpAgentStrategy;
  /** Identity sent at `initialize`. Defaults to "agent-kit". */
  clientName?: string;
  clientTitle?: string;
  clientVersion?: string;
  /** Default cwd for `session/new` when `startThread` omits one. */
  cwd?: string;
  /** MCP servers to attach at `session/new` / `session/load`. */
  mcpServers?: AcpMcpServerConfig[];
  now?: () => number;
  logger?: Logger;
};

export type AcpStartThreadOptions = {
  /** Working directory for the agent session. */
  cwd?: string;
  mcpServers?: AcpMcpServerConfig[];
};

export type AcpStartTurnOptions = {
  threadId: string;
  /** Plain prompt text. */
  prompt?: string;
  /** Pre-built ACP content blocks (text/image); overrides `prompt` when set. */
  promptContent?: AcpPromptContentBlock[];
};

/** Fired when the normalizer extracts a thread title from the stream. */
export type AcpTitleHandler = (event: {
  threadId: string;
  title: string;
}) => void;

/** Fired when runtime capabilities (models/modes/config-options) are observed. */
export type AcpRuntimeCapabilitiesHandler = (event: {
  threadId?: string;
  runtimeCapabilities: AcpRuntimeCapabilities;
  runtimeState?: AcpSessionRuntimeState;
}) => void;

type AcpSessionState = {
  threadId: string;
  protocolSessionId: string;
  normalizer: AcpSessionNormalizer;
  turnId: string | undefined;
  runtimeState: AcpSessionRuntimeState | undefined;
};

const DEFAULT_CLIENT_NAME = "agent-kit";

/** Map a neutral approval decision onto an ACP permission decision token. */
function permissionDecisionToken(decision: NormalizedApprovalDecision): string {
  switch (decision) {
    case "approved":
      return "approve";
    case "abort":
    case "denied":
    default:
      return "reject";
  }
}

export class AcpAgentClient implements AgentBackend<AcpStartThreadOptions, AcpStartTurnOptions> {
  private readonly transport: AcpJsonRpcTransport;
  private readonly strategy: AcpAgentStrategy;
  private readonly now: () => number;
  private readonly logger: Logger;

  private readonly eventListeners = new Set<(event: NormalizedThreadEvent) => void>();
  private toolCallHandler: AgentBackendToolCallHandler | null = null;
  private approvalHandler: AgentBackendApprovalHandler | null = null;
  private titleHandler: AcpTitleHandler | null = null;
  private runtimeCapabilitiesHandler: AcpRuntimeCapabilitiesHandler | null = null;

  // threadId ↔ protocol sessionId mapping + per-session state.
  private readonly sessions = new Map<string, AcpSessionState>();
  private readonly threadIdByProtocolId = new Map<string, string>();

  private unsubscribeNotification: (() => void) | undefined = undefined;
  private unsubscribeRequest: (() => void) | undefined = undefined;
  private initialized = false;
  private runtimeCapabilities?: AcpRuntimeCapabilities;
  private threadSequence = 0;

  constructor(options: AcpAgentClientOptions) {
    this.transport = options.transport;
    this.strategy = options.strategy;
    this.now = options.now ?? Date.now;
    this.logger = options.logger ?? noopLogger;
    this.clientName = options.clientName ?? DEFAULT_CLIENT_NAME;
    this.clientTitle = options.clientTitle ?? this.clientName;
    this.clientVersion = options.clientVersion ?? "0.0.0";
    this.defaultCwd = options.cwd;
    this.defaultMcpServers = options.mcpServers ?? [];
  }

  private readonly clientName: string;
  private readonly clientTitle: string;
  private readonly clientVersion: string;
  private readonly defaultCwd: string | undefined;
  private readonly defaultMcpServers: AcpMcpServerConfig[];

  // ---- subscriptions (mirror CodexThreadClient) ----

  onEvent(cb: (event: NormalizedThreadEvent) => void): Unsubscribe {
    this.eventListeners.add(cb);
    return () => {
      this.eventListeners.delete(cb);
    };
  }

  onToolCall(handler: AgentBackendToolCallHandler): Unsubscribe {
    this.toolCallHandler = handler;
    return () => {
      if (this.toolCallHandler === handler) this.toolCallHandler = null;
    };
  }

  onApprovalRequest(handler: AgentBackendApprovalHandler): Unsubscribe {
    this.approvalHandler = handler;
    return () => {
      if (this.approvalHandler === handler) this.approvalHandler = null;
    };
  }

  /** Subscribe to title extraction (topic-update / session-summary). */
  onTitle(handler: AcpTitleHandler): Unsubscribe {
    this.titleHandler = handler;
    return () => {
      if (this.titleHandler === handler) this.titleHandler = null;
    };
  }

  /** Subscribe to runtime-capabilities (models/modes/config-options) changes. */
  onRuntimeCapabilities(handler: AcpRuntimeCapabilitiesHandler): Unsubscribe {
    this.runtimeCapabilitiesHandler = handler;
    return () => {
      if (this.runtimeCapabilitiesHandler === handler) {
        this.runtimeCapabilitiesHandler = null;
      }
    };
  }

  // ---- lifecycle ----

  async startThread(
    options: AcpStartThreadOptions = {}
  ): Promise<AgentBackendStartThreadResult> {
    await this.initialize();
    const cwd = options.cwd ?? this.defaultCwd ?? process.cwd();
    const mcpServers = options.mcpServers ?? this.defaultMcpServers;
    const result = await this.transport.request("session/new", {
      cwd,
      mcpServers
    });
    const record = asRecord(result);
    const protocolSessionId =
      readString(record, "sessionId") ?? readString(record, "session_id");
    if (!protocolSessionId) {
      throw new Error("ACP session/new did not return a session id");
    }
    const threadId = `acp:${this.strategy.id}:${++this.threadSequence}`;
    const session: AcpSessionState = {
      threadId,
      protocolSessionId,
      normalizer: new AcpSessionNormalizer({ quirks: this.strategy.quirks }),
      turnId: undefined,
      runtimeState: undefined
    };
    this.sessions.set(threadId, session);
    this.threadIdByProtocolId.set(protocolSessionId, threadId);

    const runtimeCapabilities = this.captureRuntimeCapabilities("session-new", result);
    if (runtimeCapabilities) {
      const runtimeState = acpSessionRuntimeStateFromCapabilities(
        runtimeCapabilities,
        this.now()
      );
      if (runtimeState) session.runtimeState = runtimeState;
      this.notifyRuntimeCapabilities({ threadId, runtimeCapabilities, runtimeState });
      this.emitThreadSettings(session, runtimeCapabilities, runtimeState);
    }

    this.logger.debug("acp thread started", { threadId, protocolSessionId });
    const out: AgentBackendStartThreadResult = { threadId };
    const model = runtimeCapabilities?.models?.currentModelId;
    if (model !== undefined) out.model = model;
    out.modelProvider = this.strategy.id;
    return out;
  }

  async startTurn(options: AcpStartTurnOptions): Promise<{ turnId: string }> {
    const session = this.requireSession(options.threadId);
    if (session.turnId !== undefined) {
      throw new Error("A turn is already active for this ACP session.");
    }
    const turnId = `turn:${session.threadId}:${this.now()}`;
    session.turnId = turnId;
    session.normalizer.resetTurn();
    this.emit({ kind: "turn_started", threadId: session.threadId, turnId });

    const prompt =
      options.promptContent ??
      textPrompt(options.prompt ?? "");

    try {
      await this.transport.request(
        "session/prompt",
        {
          sessionId: session.protocolSessionId,
          prompt
        },
        ACP_PROMPT_REQUEST_TIMEOUT_MS
      );
    } catch (error) {
      session.turnId = undefined;
      this.emit({
        kind: "turn_completed",
        threadId: session.threadId,
        turnId,
        status: "failed"
      });
      this.emit({
        kind: "error",
        threadId: session.threadId,
        turnId,
        message: errorMessage(error)
      });
      throw error;
    }

    // Flush any in-flight assistant bubble into a terminal agent_message.
    for (const event of session.normalizer.finalizeAssistantMessage({
      threadId: session.threadId,
      turnId
    })) {
      this.emit(event);
    }
    session.turnId = undefined;
    this.emit({
      kind: "turn_completed",
      threadId: session.threadId,
      turnId,
      status: "completed"
    });
    return { turnId };
  }

  async interruptTurn(threadId: string): Promise<void> {
    const session = this.requireSession(threadId);
    if (this.transport.notify) {
      await this.transport.notify("session/cancel", {
        sessionId: session.protocolSessionId
      });
    } else {
      await this.transport.request("session/cancel", {
        sessionId: session.protocolSessionId
      });
    }
  }

  async setMode(threadId: string, modeId: string): Promise<void> {
    await this.setRuntimeOption(threadId, "mode", modeId, modeId);
  }

  async setModel(threadId: string, modelId: string): Promise<void> {
    await this.setRuntimeOption(threadId, "model", modelId, modelId);
  }

  async setConfigOption(
    threadId: string,
    optionId: string,
    value: string
  ): Promise<void> {
    await this.setRuntimeOption(threadId, "configOption", optionId, value);
  }

  async close(): Promise<void> {
    this.unsubscribeNotification?.();
    this.unsubscribeNotification = undefined;
    this.unsubscribeRequest?.();
    this.unsubscribeRequest = undefined;
    this.sessions.clear();
    this.threadIdByProtocolId.clear();
    this.initialized = false;
    await this.transport.close?.();
  }

  // ---- internals ----

  private emit(event: NormalizedThreadEvent): void {
    for (const listener of this.eventListeners) listener(event);
  }

  private async initialize(): Promise<void> {
    if (this.initialized) return;

    this.unsubscribeNotification = this.transport.onNotification((method, params) => {
      this.handleNotification(method, params);
    });
    this.unsubscribeRequest = this.transport.onRequest?.(
      async (method, params, id) => await this.handleAcpRequest(method, params, id)
    );

    const result = await this.transport.request(
      "initialize",
      {
        protocolVersion: ACP_PROTOCOL_VERSION,
        clientCapabilities: {
          auth: { terminal: false },
          fs: { readTextFile: false, writeTextFile: false },
          terminal: false
        },
        clientInfo: {
          name: this.clientName,
          title: this.clientTitle,
          version: this.clientVersion
        }
      },
      ACP_REQUEST_TIMEOUT_MS
    );
    const runtimeCapabilities = this.captureRuntimeCapabilities("initialize", result);
    if (runtimeCapabilities) {
      this.notifyRuntimeCapabilities({ runtimeCapabilities });
    }
    this.initialized = true;
  }

  private handleNotification(method: string, params: unknown): void {
    const vendorMethods = this.strategy.quirks.vendorNotificationMethods ?? [];
    if (method !== "session/update" && !vendorMethods.includes(method)) {
      return;
    }
    const record = asRecord(params);
    if (!record) return;
    this.applySessionUpdate(record);
  }

  private applySessionUpdate(params: Record<string, unknown>): void {
    const protocolSessionId =
      readString(params, "sessionId") ?? readString(params, "session_id");
    const update = asRecord(params.update);
    if (!protocolSessionId || !update) {
      return;
    }
    const threadId = this.threadIdByProtocolId.get(protocolSessionId);
    const session = threadId ? this.sessions.get(threadId) : undefined;
    if (!session) {
      this.logger.debug("acp session/update for unknown session", { protocolSessionId });
      return;
    }

    // Runtime-state changes (mode/model/config) ride session/update too.
    const runtimeState = acpSessionRuntimeStateFromUpdate(update, this.now());
    if (runtimeState) {
      session.runtimeState = mergeAcpRuntimeState(session.runtimeState, runtimeState);
      if (this.runtimeCapabilities) {
        this.notifyRuntimeCapabilities({
          threadId: session.threadId,
          runtimeCapabilities: this.runtimeCapabilities,
          runtimeState: session.runtimeState
        });
      }
      this.emitThreadSettings(session, this.runtimeCapabilities, session.runtimeState);
      return;
    }

    const ctx: AcpApplyContext = {
      threadId: session.threadId,
      turnId: session.turnId ?? `turn:${session.threadId}:detached`
    };
    const result = session.normalizer.apply(update, ctx);
    if (result.title !== undefined) {
      this.titleHandler?.({ threadId: session.threadId, title: result.title });
      return;
    }
    for (const event of result.events) {
      this.emit(event);
    }
  }

  private async handleAcpRequest(
    method: string,
    params: Record<string, unknown>,
    id?: JsonRpcId
  ): Promise<unknown> {
    if (method === "session/request_permission") {
      return await this.handlePermissionRequest(params, id);
    }
    // Any other inbound server-request (e.g. a future tool-call request) routes
    // to the tool-call handler when one is registered.
    if (this.toolCallHandler) {
      const call: AgentBackendToolCall = { method, params };
      return await this.toolCallHandler(call);
    }
    throw new Error(`Unsupported ACP request: ${method}`);
  }

  private async handlePermissionRequest(
    params: Record<string, unknown>,
    id?: JsonRpcId
  ): Promise<unknown> {
    const protocolSessionId =
      readString(params, "sessionId") ?? readString(params, "session_id");
    const threadId = protocolSessionId
      ? this.threadIdByProtocolId.get(protocolSessionId)
      : undefined;
    const options = readPermissionOptions(params.options);
    const handler = this.approvalHandler;
    if (!handler) {
      return cancelledPermissionOutcome();
    }

    const approval = buildApprovalRequest({
      params,
      id,
      threadId,
      session: threadId ? this.sessions.get(threadId) : undefined,
      now: this.now
    });
    if (threadId) {
      this.emit({ kind: "approval_request", threadId, approval });
    }

    const decision = await handler("session/request_permission", params);
    return permissionOutcomeFromDecision(decision, options);
  }

  private async setRuntimeOption(
    threadId: string,
    source: AcpRuntimeOptionSource,
    optionId: string,
    value: string
  ): Promise<void> {
    const session = this.requireSession(threadId);
    const result = await this.setRuntimeOptionOnTransport(
      session.protocolSessionId,
      source,
      optionId,
      value
    );
    const runtimeCapabilities = this.captureRuntimeCapabilities("session-load", result);
    const requested: AcpSessionRuntimeState =
      source === "configOption"
        ? { configValues: { [optionId]: value }, updatedAt: this.now() }
        : source === "mode"
          ? { currentModeId: value, updatedAt: this.now() }
          : { currentModelId: value, updatedAt: this.now() };
    session.runtimeState = mergeAcpRuntimeState(session.runtimeState, requested);
    const effectiveCapabilities = runtimeCapabilities ?? this.runtimeCapabilities;
    if (effectiveCapabilities) {
      this.notifyRuntimeCapabilities({
        threadId,
        runtimeCapabilities: effectiveCapabilities,
        ...(session.runtimeState !== undefined
          ? { runtimeState: session.runtimeState }
          : {})
      });
    }
    this.emitThreadSettings(session, effectiveCapabilities, session.runtimeState);
  }

  private async setRuntimeOptionOnTransport(
    protocolSessionId: string,
    source: AcpRuntimeOptionSource,
    optionId: string,
    value: string
  ): Promise<unknown> {
    if (source === "configOption") {
      return await this.transport.request("session/set_config_option", {
        sessionId: protocolSessionId,
        configId: optionId,
        value
      });
    }
    if (source === "mode") {
      return await this.transport.request("session/set_mode", {
        sessionId: protocolSessionId,
        modeId: value
      });
    }
    return await this.transport.request("session/set_model", {
      sessionId: protocolSessionId,
      modelId: value
    });
  }

  private captureRuntimeCapabilities(
    source: AcpRuntimeCapabilities["source"],
    result: unknown
  ): AcpRuntimeCapabilities | undefined {
    const runtimeCapabilities = normalizeAcpRuntimeCapabilities({
      value: result,
      now: this.now(),
      source,
      ...(this.runtimeCapabilities !== undefined
        ? { initialize: this.runtimeCapabilities }
        : {})
    });
    if (runtimeCapabilities) {
      this.runtimeCapabilities = runtimeCapabilities;
    }
    return runtimeCapabilities;
  }

  private notifyRuntimeCapabilities(event: {
    threadId?: string | undefined;
    runtimeCapabilities: AcpRuntimeCapabilities;
    runtimeState?: AcpSessionRuntimeState | undefined;
  }): void {
    this.runtimeCapabilitiesHandler?.({
      ...(event.threadId !== undefined ? { threadId: event.threadId } : {}),
      runtimeCapabilities: event.runtimeCapabilities,
      ...(event.runtimeState !== undefined ? { runtimeState: event.runtimeState } : {})
    });
  }

  private emitThreadSettings(
    session: AcpSessionState,
    capabilities: AcpRuntimeCapabilities | undefined,
    runtimeState: AcpSessionRuntimeState | undefined
  ): void {
    const settings: NormalizedThreadSettings = { threadId: session.threadId };
    const model =
      runtimeState?.currentModelId ?? capabilities?.models?.currentModelId;
    if (model !== undefined) settings.model = model;
    settings.modelProvider = this.strategy.id;
    const modeId =
      runtimeState?.currentModeId ?? capabilities?.modes?.currentModeId;
    if (modeId !== undefined) {
      settings.modeId = modeId;
      const label = modeLabelFor(capabilities, modeId);
      if (label !== undefined) settings.modeLabel = label;
    }
    this.emit({ kind: "thread_settings", settings });
  }

  private requireSession(threadId: string): AcpSessionState {
    const session = this.sessions.get(threadId);
    if (!session) {
      throw new Error(`Unknown ACP thread: ${threadId}`);
    }
    return session;
  }

  /** Whether the agent advertises session/load support (for hosts that resume). */
  supportsSessionLoad(): boolean {
    return acpRuntimeSupportsSessionLoad(this.runtimeCapabilities);
  }
}

function buildApprovalRequest(args: {
  params: Record<string, unknown>;
  id: JsonRpcId | undefined;
  threadId: string | undefined;
  session: AcpSessionState | undefined;
  now: () => number;
}): NormalizedApprovalRequest {
  const toolCall = asRecord(args.params.toolCall) ?? {};
  const title =
    typeof toolCall.title === "string" && toolCall.title.trim()
      ? toolCall.title.trim()
      : "ACP tool call";
  const toolCallId =
    readString(toolCall, "toolCallId") ?? readString(toolCall, "tool_call_id");
  const requestId =
    args.id == null ? toolCallId ?? `acp:${args.now()}` : String(args.id);
  const acpKind = typeof toolCall.kind === "string" ? toolCall.kind : undefined;
  const approval: NormalizedApprovalRequest = {
    id: requestId,
    method: "session/request_permission",
    kind: approvalKindFor(acpKind),
    params: args.params
  };
  approval.summary = acpKind ? `${acpKind}: ${title}` : title;
  return approval;
}

function approvalKindFor(acpKind: string | undefined): NormalizedApprovalRequest["kind"] {
  switch (acpKind) {
    case "execute":
    case "exec":
    case "shell":
      return "exec";
    case "edit":
    case "write":
      return "patch";
    case "read":
    case "search":
    case "fetch":
      return "tool";
    default:
      return "other";
  }
}

type AcpPermissionOption = {
  optionId: string;
  name?: string;
  kind?: string;
};

function readPermissionOptions(value: unknown): AcpPermissionOption[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((option) => {
    const record = asRecord(option);
    const optionId = readString(record, "optionId");
    if (!record || !optionId) {
      return [];
    }
    const normalized: AcpPermissionOption = { optionId };
    const name = readString(record, "name");
    if (name !== undefined) normalized.name = name;
    const kind = readString(record, "kind");
    if (kind !== undefined) normalized.kind = kind;
    return [normalized];
  });
}

function permissionOutcomeFromDecision(
  decision: NormalizedApprovalDecision,
  options: AcpPermissionOption[]
): { outcome: { outcome: "selected"; optionId: string } | { outcome: "cancelled" } } {
  const token = permissionDecisionToken(decision);
  const optionId = selectPermissionOptionId(token, options);
  return optionId
    ? { outcome: { outcome: "selected", optionId } }
    : cancelledPermissionOutcome();
}

function cancelledPermissionOutcome(): { outcome: { outcome: "cancelled" } } {
  return { outcome: { outcome: "cancelled" } };
}

function selectPermissionOptionId(
  decision: string,
  options: AcpPermissionOption[]
): string | undefined {
  const normalized = decision.toLowerCase();
  const exact = options.find((option) =>
    [option.optionId, option.name, option.kind]
      .filter((value): value is string => typeof value === "string")
      .some((value) => value.toLowerCase() === normalized)
  );
  if (exact) {
    return exact.optionId;
  }
  if (normalized === "approve" || normalized === "accept" || normalized === "allow") {
    return (
      options.find((option) => option.kind === "allow_once") ??
      options.find((option) => option.kind === "allow_always") ??
      options.find((option) => option.name?.toLowerCase().includes("allow"))
    )?.optionId;
  }
  if (normalized === "reject" || normalized === "decline" || normalized === "deny") {
    return (
      options.find((option) => option.kind === "reject_once") ??
      options.find((option) => option.name?.toLowerCase().includes("reject"))
    )?.optionId;
  }
  return undefined;
}

function textPrompt(text: string): AcpPromptContentBlock[] {
  return [{ type: "text", text }];
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim()) {
    return error.message;
  }
  const message = String(error).trim();
  return message || "Turn failed.";
}

function readString(
  record: Record<string, unknown> | undefined,
  key: string
): string | undefined {
  const value = record?.[key];
  return typeof value === "string" ? value : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
