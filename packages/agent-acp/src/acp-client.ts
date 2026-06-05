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
  type AgentStartThreadOptions,
  type AgentStartTurnOptions,
  type Logger,
  type NormalizedApprovalDecision,
  type NormalizedApprovalRequest,
  type NormalizedThreadEvent,
  type NormalizedThreadSettings,
  type NormalizedTokenUsage,
  type Unsubscribe
} from "@pwrdrvr/agent-core";
import { mkdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { extname } from "node:path";
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

/** ACP-NATIVE thread/start options. **No longer the public `startThread`
 *  surface** — `AcpAgentClient` implements the non-generic `AgentBackend` and its
 *  public `startThread` takes neutral `AgentStartThreadOptions`. Retained as the
 *  internal mapping target and exposed via `startThreadNative` for hosts wanting
 *  ACP-specific control (e.g. per-thread `mcpServers`). */
export type AcpStartThreadOptions = {
  /** Working directory for the agent session. */
  cwd?: string;
  mcpServers?: AcpMcpServerConfig[];
};

/** ACP-NATIVE turn/start options. Internal mapping target; the public `startTurn`
 *  takes neutral `AgentStartTurnOptions`. */
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
  /** The in-flight `session/prompt` completion chain for the active turn.
   *  `startTurnNative` resolves at turn START and streams terminal events from
   *  this chain when the request settles; `undefined` between turns. Awaited by
   *  `close()` so teardown doesn't orphan a running turn. The chain is
   *  `.catch`-terminated, so it never rejects. */
  pendingTurn: Promise<void> | undefined;
  /** System prompt captured from the neutral `startThread({ instructions })`.
   *  ACP has no `session/new` baseInstructions seam, so we fold it into the
   *  FIRST turn's prompt as a leading text block (same approach the one-shot
   *  enrichment client uses), then clear it. `undefined` once consumed / when
   *  the host supplied none. */
  pendingInstructions: string | undefined;
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

export class AcpAgentClient implements AgentBackend {
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

  /**
   * Public `AgentBackend.startThread`: accepts NEUTRAL `AgentStartThreadOptions`
   * and maps them onto an ACP `session/new`. ACP supports:
   *   • `cwd` → `session/new.cwd`.
   *   • `model` → applied via `session/set_model` after the session opens, when
   *     the agent advertises model selection (best-effort; debug-logged if not).
   *   • `instructions` is NOT injected here — ACP `session/new` has no base-
   *     instructions slot, matching the adapter's existing behavior. A host that
   *     wants system framing sends it as leading turn text.
   * Codex-only fields (`approvalPolicy`, `sandbox`, `config`, `environments`,
   * `tools`, `serviceName`, `modelProvider`, `serviceTier`, `workspaceRoots`) are
   * IGNORED — logged at debug so it's visible the backend doesn't honor them.
   */
  async startThread(
    options: AgentStartThreadOptions = {}
  ): Promise<AgentBackendStartThreadResult> {
    const ignored: string[] = [];
    for (const key of [
      "approvalPolicy",
      "sandbox",
      "config",
      "environments",
      "tools",
      "serviceName",
      "modelProvider",
      "serviceTier",
      "workspaceRoots"
    ] as const) {
      if (options[key] !== undefined) ignored.push(key);
    }
    if (ignored.length > 0) {
      this.logger.debug("acp startThread: ignoring Codex-only neutral options", {
        ignored
      });
    }
    const native: AcpStartThreadOptions = {};
    if (options.cwd !== undefined) native.cwd = options.cwd;
    const result = await this.startThreadNative(native);
    // ACP has no `session/new` system-prompt seam, so stash the host's
    // `instructions` and fold them into the first turn's prompt (below). Without
    // this an ACP chat agent runs with NO host system prompt / persona / anchor
    // context — just its own CLI harness prompt.
    if (typeof options.instructions === "string" && options.instructions.length > 0) {
      const session = this.sessions.get(result.threadId);
      if (session) session.pendingInstructions = options.instructions;
    }
    if (options.model !== undefined) {
      await this.setModel(result.threadId, options.model).catch((cause) => {
        this.logger.debug("acp startThread: model selection not applied", {
          model: options.model,
          message: cause instanceof Error ? cause.message : String(cause)
        });
      });
    }
    return result;
  }

  /** ACP-native `session/new`. The neutral `startThread` delegates here after
   *  mapping cwd + dropping Codex-only fields. Exposed for hosts that need
   *  ACP-specific control (per-thread `mcpServers`). */
  async startThreadNative(
    options: AcpStartThreadOptions = {}
  ): Promise<AgentBackendStartThreadResult> {
    await this.initialize();
    const cwd = options.cwd ?? this.defaultCwd ?? process.cwd();
    // Ensure the session workspace exists. ACP agents use `cwd` as their
    // working directory; some (e.g. Gemini) fail `session/new` with an opaque
    // "-32603 Internal error" when it doesn't exist. Best-effort — if the
    // mkdir fails the agent surfaces its own error as before.
    try {
      mkdirSync(cwd, { recursive: true });
    } catch (cause) {
      this.logger.debug("acp session cwd ensure failed", {
        cwd,
        message: cause instanceof Error ? cause.message : String(cause)
      });
    }
    // Serialize to the ACP `McpServer` wire shape: `args` is required and `env`
    // is an array of `{ name, value }` — NOT the ergonomic `Record` we accept
    // from hosts. Passing a record (or omitting args) makes strict agents (e.g.
    // Gemini) fail `session/new` with an opaque "-32603 Internal error".
    const mcpServers = (options.mcpServers ?? this.defaultMcpServers).map((server) => ({
      name: server.name,
      command: server.command,
      args: server.args ?? [],
      env: Object.entries(server.env ?? {}).map(([name, value]) => ({ name, value }))
    }));
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
    // Host-minted UUID, NOT a counter. ACP returns a session GUID
    // (`protocolSessionId`, used below for wire routing), but the host-facing
    // `threadId` is our own handle — a per-thread `randomUUID()` is globally
    // unique regardless of how (or whether) a given agent makes its session id
    // unique, so hosts persisting threads under a UNIQUE id never collide
    // across threads, client instances, or process restarts.
    const threadId = `acp:${this.strategy.id}:${randomUUID()}`;
    const session: AcpSessionState = {
      threadId,
      protocolSessionId,
      normalizer: new AcpSessionNormalizer({ quirks: this.strategy.quirks }),
      turnId: undefined,
      runtimeState: undefined,
      pendingTurn: undefined,
      pendingInstructions: undefined
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

  /**
   * Public `AgentBackend.startTurn`: accepts NEUTRAL `AgentStartTurnOptions` and
   * maps them onto ACP prompt content blocks — a leading `text` block from
   * `input.text`, then one `image` block per `input.imagePaths` entry (read from
   * disk, base64-encoded, mimeType inferred from extension). `reasoning` maps to
   * an ACP mode/config when the session advertises a matching option, else it is
   * IGNORED (debug-logged).
   */
  async startTurn(options: AgentStartTurnOptions): Promise<{ turnId: string }> {
    const promptContent: AcpPromptContentBlock[] = [];
    // Fold the host system prompt (captured at startThread) into the FIRST turn
    // as a leading text block — ACP has no baseInstructions seam. Consumed once.
    const session = this.sessions.get(options.threadId);
    if (session?.pendingInstructions !== undefined) {
      promptContent.push({ type: "text", text: session.pendingInstructions });
      session.pendingInstructions = undefined;
    }
    promptContent.push({ type: "text", text: options.input.text });
    for (const imagePath of options.input.imagePaths ?? []) {
      const block = await this.imageBlockFromPath(imagePath).catch((cause) => {
        this.logger.debug("acp startTurn: skipping unreadable image", {
          imagePath,
          message: cause instanceof Error ? cause.message : String(cause)
        });
        return undefined;
      });
      if (block !== undefined) promptContent.push(block);
    }
    if (options.reasoning !== undefined) {
      await this.applyReasoning(options.threadId, options.reasoning).catch((cause) => {
        this.logger.debug("acp startTurn: reasoning not applied", {
          reasoning: options.reasoning,
          message: cause instanceof Error ? cause.message : String(cause)
        });
      });
    }
    return this.startTurnNative({ threadId: options.threadId, promptContent });
  }

  /** ACP-native `session/prompt`. Takes a plain prompt or pre-built content
   *  blocks. The neutral `startTurn` delegates here after building blocks. */
  async startTurnNative(options: AcpStartTurnOptions): Promise<{ turnId: string }> {
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

    // Resolve at turn START, not turn END. ACP's `session/prompt` resolves only
    // when the whole turn is done (assistant chunks arrive as `session/update`
    // notifications WHILE the request is in flight). Awaiting it here would make
    // `startTurn` block for the entire turn — violating the `AgentBackend`
    // contract (Codex resolves at turn start) and freezing any host UI that
    // gates on `startTurn` (e.g. a chat composer waiting to clear). Instead we
    // fire the request and stream its terminal events (token_usage,
    // agent_message, turn_completed/error) asynchronously when it settles.
    session.pendingTurn = this.transport
      .request(
        "session/prompt",
        {
          sessionId: session.protocolSessionId,
          prompt
        },
        ACP_PROMPT_REQUEST_TIMEOUT_MS
      )
      .then((promptResult) => {
        // Token usage rides on the `session/prompt` RESPONSE (`_meta.quota`),
        // not a session/update — emit it so hosts can account for ACP turns the
        // same way they do Codex turns.
        const usage = readAcpPromptUsage(promptResult);
        if (usage) {
          this.emit({ kind: "token_usage", threadId: session.threadId, turnId, usage });
        }
        // Flush any in-flight assistant bubble into a terminal agent_message.
        for (const event of session.normalizer.finalizeAssistantMessage({
          threadId: session.threadId,
          turnId
        })) {
          this.emit(event);
        }
        session.turnId = undefined;
        session.pendingTurn = undefined;
        this.emit({
          kind: "turn_completed",
          threadId: session.threadId,
          turnId,
          status: "completed"
        });
      })
      .catch((error) => {
        session.turnId = undefined;
        session.pendingTurn = undefined;
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
    // Snapshot in-flight turn chains before clearing sessions. Closing the
    // transport rejects any pending `session/prompt`, which the chain's
    // `.catch` turns into a terminal failed/error emit — await them so teardown
    // doesn't leave a turn settling after `close()` resolves. The chains never
    // reject (they're `.catch`-terminated), so `allSettled` is belt-and-braces.
    const pending = [...this.sessions.values()]
      .map((s) => s.pendingTurn)
      .filter((p): p is Promise<void> => p !== undefined);
    this.sessions.clear();
    this.threadIdByProtocolId.clear();
    this.initialized = false;
    await this.transport.close?.();
    if (pending.length > 0) await Promise.allSettled(pending);
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

  /** Map a neutral `reasoning` token onto an ACP runtime option. We try to match
   *  it to an available MODE (by id or label, case-insensitively) and switch via
   *  `session/set_mode`. ACP has no first-class "reasoning effort" concept, so if
   *  no mode matches we leave it alone — the caller's `.catch` debug-logs. */
  private async applyReasoning(threadId: string, reasoning: string): Promise<void> {
    const modes = this.runtimeCapabilities?.modes?.availableModes ?? [];
    const target = reasoning.toLowerCase();
    const match = modes.find(
      (mode) =>
        mode.id.toLowerCase() === target ||
        (typeof mode.label === "string" && mode.label.toLowerCase() === target)
    );
    if (match === undefined) {
      this.logger.debug("acp reasoning has no matching mode — ignored", { reasoning });
      return;
    }
    await this.setMode(threadId, match.id);
  }

  /** Read an image file and build an ACP `image` content block (base64 + inferred
   *  mimeType). Throws on read failure; the caller catches + skips. */
  private async imageBlockFromPath(imagePath: string): Promise<AcpPromptContentBlock> {
    const data = await readFile(imagePath);
    return {
      type: "image",
      mimeType: mimeTypeForImagePath(imagePath),
      data: data.toString("base64")
    };
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

/** Best-effort image mimeType from a file extension. Falls back to PNG. */
function mimeTypeForImagePath(imagePath: string): string {
  switch (extname(imagePath).toLowerCase()) {
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".gif":
      return "image/gif";
    case ".webp":
      return "image/webp";
    case ".bmp":
      return "image/bmp";
    case ".svg":
      return "image/svg+xml";
    case ".png":
    default:
      return "image/png";
  }
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

/** Read token usage from a `session/prompt` response. Agents report it in
 *  `_meta.quota.token_count`, e.g. Gemini:
 *  `{ _meta: { quota: { token_count: { input_tokens, output_tokens } } } }`.
 *  Returns undefined when no usage is present. */
function readAcpPromptUsage(result: unknown): NormalizedTokenUsage | undefined {
  const meta = asRecord(asRecord(result)?._meta);
  const tokenCount = asRecord(asRecord(meta?.quota)?.token_count);
  if (!tokenCount) return undefined;
  const num = (value: unknown): number | undefined =>
    typeof value === "number" && Number.isFinite(value) ? value : undefined;
  const input = num(tokenCount.input_tokens);
  const output = num(tokenCount.output_tokens);
  const cached = num(tokenCount.cached_input_tokens ?? tokenCount.cached_tokens);
  const reasoning = num(tokenCount.thoughts_tokens ?? tokenCount.reasoning_tokens);
  if (input === undefined && output === undefined) return undefined;
  const usage: NormalizedTokenUsage = { totalTokens: (input ?? 0) + (output ?? 0) };
  if (input !== undefined) usage.inputTokens = input;
  if (output !== undefined) usage.outputTokens = output;
  if (cached !== undefined) usage.cachedInputTokens = cached;
  if (reasoning !== undefined) usage.reasoningOutputTokens = reasoning;
  return usage;
}
