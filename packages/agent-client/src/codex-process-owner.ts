// Codex App Server process OWNER + per-surface backend VIEWS.
//
// One `CodexProcessOwner` owns exactly ONE `codex app-server` child process and
// its JSON-RPC connection (keyed, by the host, on `(command, CODEX_HOME/env)`).
// Multiple chat surfaces — Library chat, Sizzle chat, capture enrichment,
// model-picker refresh — share that single process instead of each spawning
// their own. The owner multiplexes:
//
//   • N `CodexBackendView`s   — each a lightweight `AgentBackend` a surface
//     drives (its own `onEvent` / `onToolCall` / `onApprovalRequest`). Inbound
//     notifications AND tool-call/approval server-requests are demultiplexed by
//     `threadId` to the view that owns that thread, so sibling surfaces never
//     clobber each other's handlers. (Plain `CodexThreadClient` exposes a single
//     global handler slot — that is exactly the clobber this fixes.)
//   • `listModels()`          — model listing over the shared connection (no
//     extra process, no one-shot client needed).
//   • `runOneShot()`          — structured-output enrichment turns over a
//     persistent worker thread on the SAME connection (outputSchema, local
//     images, per-turn rollback, token usage, abort), so enrichment doesn't
//     spawn a second App Server either.
//
// Every Codex notification and every server-request carries a `threadId`
// (`DynamicToolCallParams`, the v2 `*RequestApprovalParams`, and notifications
// all do; legacy v1 approvals carry `conversationId`) — that is what makes
// per-thread routing possible.

import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  noopLogger,
  type AgentBackend,
  type AgentBackendApprovalHandler,
  type AgentBackendStartThreadResult,
  type AgentBackendToolCall,
  type AgentBackendToolCallHandler,
  type AgentForkThreadOptions,
  type AgentStartThreadOptions,
  type AgentStartTurnOptions,
  type Logger,
  type NormalizedApprovalDecision,
  type NormalizedThreadEvent,
  type NormalizedTokenUsage,
  type Unsubscribe
} from "@pwrdrvr/agent-core";
import {
  JsonRpcConnection,
  StdioJsonRpcTransport,
  type JsonRpcTransport
} from "@pwrdrvr/agent-transport";
import { resolveCodexCommand } from "@pwrdrvr/codex-discovery";
import type {
  InitializeParams,
  InitializeResponse,
  Personality,
  ReasoningEffort,
  ResponseItem,
  ServerNotification
} from "@pwrdrvr/codex-app-server-protocol";
import type {
  AskForApproval,
  DynamicToolCallResponse,
  DynamicToolSpec,
  ItemCompletedNotification,
  Model,
  ModelListResponse,
  SandboxMode,
  ThreadForkParams,
  ThreadForkResponse,
  ThreadResumeParams,
  ThreadResumeResponse,
  ThreadStartParams,
  ThreadStartResponse,
  ThreadTokenUsage,
  ThreadTokenUsageUpdatedNotification,
  TurnCompletedNotification,
  TurnStartParams,
  TurnStartResponse,
  UserInput
} from "@pwrdrvr/codex-app-server-protocol/v2";
import {
  CODEX_APPROVAL_METHODS,
  CODEX_TOOL_CALL_METHOD,
  normalizeNotification,
  normalizeTokenUsage
} from "./normalize";

export type { Unsubscribe } from "@pwrdrvr/agent-core";

export type CodexTransportFactory = (command: string) => JsonRpcTransport;

/** Identity + lifecycle options for an owned Codex process. The connection
 *  identity (`clientName`/`env`/`command`) is also what a pool keys on. */
export type CodexProcessOwnerOptions = {
  /** Configured command to resolve. `"codex"` (or empty) triggers discovery. */
  command?: string;
  /** Identity sent as `clientInfo.name` at `initialize`. Defaults to "agent-kit". */
  clientName?: string;
  /** Human title sent as `clientInfo.title`. Defaults to `clientName`. */
  clientTitle?: string;
  /** Version sent as `clientInfo.version`. Defaults to "0.0.0". */
  clientVersion?: string;
  /** Default `serviceName` applied at `thread/start` when a caller omits one. */
  serviceName?: string;
  requestTimeoutMs?: number;
  turnTimeoutMs?: number;
  /** Process env passed to the spawned codex. Defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
  /** Override the transport (tests inject an in-memory fake). When supplied, no
   *  discovery/spawn happens. */
  transportFactory?: CodexTransportFactory;
  logger?: Logger;
  /** Config for the `runOneShot` persistent worker thread. */
  worker?: CodexOneShotWorkerOptions;
};

export type CodexOneShotWorkerOptions = {
  /** Working dir for the persistent worker thread (keeps it out of any repo). */
  workspaceDir?: string;
  /** Human-readable name set on the worker thread. */
  threadName?: string;
  /** Per-thread Codex config overlay applied to the worker thread. */
  threadConfig?: Record<string, unknown>;
};

/**
 * Codex-NATIVE thread/start options. The neutral `AgentBackend.startThread`
 * surface maps `AgentStartThreadOptions` onto this; it is also exposed via
 * `CodexBackendView.startThreadNative` for hosts wanting full Codex control.
 */
export type CodexStartThreadOptions = {
  approvalPolicy?: string;
  sandbox?: string;
  baseInstructions?: string;
  dynamicTools?: DynamicToolSpec[];
  cwd?: string;
  runtimeWorkspaceRoots?: string[];
  serviceName?: string;
  personality?: string;
  /** Model id to start the thread on. Omit for the Codex default. */
  model?: string;
  /** Model provider id. Omit for the Codex default. */
  modelProvider?: string;
  /** Service tier, when the host pins one. */
  serviceTier?: string;
  /** Per-thread Codex config overlay (the `-c key=value` mechanism). */
  config?: Record<string, unknown>;
  /** Thread environments. **Empty array disables exec-environment access**. */
  environments?: unknown[];
};

/** Codex-NATIVE turn/start options (the native mapping target of `startTurn`). */
export type CodexStartTurnOptions = {
  threadId: string;
  input: UserInput[];
  effort?: string;
};

/** Tool-call server-request handler (canonical neutral shape). */
export type CodexToolCallHandler = AgentBackendToolCallHandler;
/** Approval server-request handler (canonical neutral shape). */
export type CodexApprovalHandler = AgentBackendApprovalHandler;

export type StartThreadResult = {
  threadId: string;
  model: string;
  modelProvider: string;
  serviceTier: string | null;
};

export type CodexModelOption = {
  id: string;
  model: string;
  displayName: string;
  description: string;
  hidden: boolean;
  inputModalities: Model["inputModalities"];
  defaultServiceTier: string | null;
  isDefault: boolean;
};

export type CodexOneShotRequest = {
  /** The user-message text (the caller's prompt) for this turn. */
  prompt: string;
  /** Local image file paths fed as `localImage` inputs (not inlined as base64). */
  imagePaths?: readonly string[];
  /** JSON Schema constraining the final assistant message (`outputSchema`). */
  outputSchema?: unknown;
  /** Base instructions for the worker thread (changing it re-creates it). */
  baseInstructions?: string;
  /** Reasoning effort for the turn. Defaults to "low". */
  effort?: string;
  model?: string | null;
  /** Model provider for the worker thread. Omit for the Codex default. */
  modelProvider?: string | null;
  abortSignal?: AbortSignal;
};

export type CodexOneShotResponse = {
  /** The raw assistant message text. Caller parses/validates against its schema. */
  rawText: string;
  threadId: string;
  turnId: string;
  userAgent: string;
  model: string;
  modelProvider: string;
  serviceTier: string | null;
  tokenUsage: NormalizedTokenUsage | null;
};

const DEFAULT_CLIENT_NAME = "agent-kit";
const DEFAULT_SERVICE_NAME = "agent-kit";

/** Map a neutral approval decision onto the generic Codex approval response. */
function approvalResponseFor(decision: NormalizedApprovalDecision): unknown {
  switch (decision) {
    case "approved":
      return { decision: "approved" };
    case "abort":
      return { decision: "abort" };
    case "denied":
    default:
      return { decision: "denied" };
  }
}

/** A tool call arriving with no handler registered for its thread. */
function noToolHandlerResponse(): DynamicToolCallResponse {
  return {
    contentItems: [
      { type: "inputText", text: "No tool handler is registered for this thread." }
    ],
    success: false
  };
}

/** The threadId a normalized event belongs to (for view routing). Most events
 *  carry `threadId`; `thread_settings` nests it under `settings`. */
function eventThreadId(event: NormalizedThreadEvent): string | undefined {
  if (event.kind === "thread_settings") return event.settings.threadId;
  if ("threadId" in event) return event.threadId;
  return undefined;
}

/** The threadId a server-request belongs to. v2 params carry `threadId`; legacy
 *  v1 approvals (`applyPatchApproval`/`execCommandApproval`) carry `conversationId`. */
function requestThreadId(params: unknown): string | undefined {
  if (typeof params !== "object" || params === null) return undefined;
  const p = params as Record<string, unknown>;
  if (typeof p.threadId === "string") return p.threadId;
  if (typeof p.conversationId === "string") return p.conversationId;
  return undefined;
}

function modelToOption(model: Model): CodexModelOption {
  return {
    id: model.id,
    model: model.model,
    displayName: model.displayName,
    description: model.description,
    hidden: model.hidden,
    inputModalities: model.inputModalities,
    defaultServiceTier: model.defaultServiceTier,
    isDefault: model.isDefault
  };
}

function imagePathsToLocalImageInputs(imagePaths: readonly string[]): UserInput[] {
  // `localImage` lets App Server read the file as an image input. Do NOT inline a
  // base64 data URL — the bridge can account that payload like fresh text.
  return imagePaths.map((path) => ({ type: "localImage", path }));
}

type PendingOneShotTurn = {
  threadId: string;
  turnId: string;
  agentMessages: string[];
  tokenUsage: ThreadTokenUsage | null;
  resolve: (value: { rawText: string; tokenUsage: ThreadTokenUsage | null }) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

type WorkerThread = {
  threadId: string;
  modelKey: string;
  baseInstructions: string;
  model: string;
  modelProvider: string;
  serviceTier: string | null;
};

/**
 * A per-surface `AgentBackend` over a shared `CodexProcessOwner`. Each view owns
 * the threads it starts/forks/resumes/turns on; the owner routes that thread's
 * events + tool-call/approval requests back to THIS view's handlers, so two
 * surfaces sharing one process never clobber each other.
 *
 * Created via `owner.createBackendView()`. `close()` detaches the view (drops
 * its handlers + releases its threads from routing) — it does NOT stop the
 * shared process. Tear the process down via `owner.close()`.
 */
export class CodexBackendView implements AgentBackend {
  private readonly eventListeners = new Set<(event: NormalizedThreadEvent) => void>();
  private readonly ownedThreads = new Set<string>();
  private closed = false;
  /** @internal — read by the owner's server-request router. */
  toolCallHandler: CodexToolCallHandler | null = null;
  /** @internal */ approvalHandler: CodexApprovalHandler | null = null;

  constructor(private readonly owner: CodexProcessOwner) {}

  onEvent(cb: (event: NormalizedThreadEvent) => void): Unsubscribe {
    this.eventListeners.add(cb);
    return () => {
      this.eventListeners.delete(cb);
    };
  }

  onToolCall(handler: CodexToolCallHandler): Unsubscribe {
    this.toolCallHandler = handler;
    return () => {
      if (this.toolCallHandler === handler) this.toolCallHandler = null;
    };
  }

  onApprovalRequest(handler: CodexApprovalHandler): Unsubscribe {
    this.approvalHandler = handler;
    return () => {
      if (this.approvalHandler === handler) this.approvalHandler = null;
    };
  }

  /** @internal — the owner delivers a routed event to this view. */
  emit(event: NormalizedThreadEvent): void {
    for (const listener of this.eventListeners) listener(event);
  }

  /** Neutral `AgentBackend.startThread`. Maps onto `CodexStartThreadOptions`. */
  async startThread(opts: AgentStartThreadOptions = {}): Promise<StartThreadResult> {
    const native: CodexStartThreadOptions = {};
    if (opts.instructions !== undefined) native.baseInstructions = opts.instructions;
    if (opts.cwd !== undefined) native.cwd = opts.cwd;
    if (opts.workspaceRoots !== undefined) native.runtimeWorkspaceRoots = [...opts.workspaceRoots];
    if (opts.model !== undefined) native.model = opts.model;
    if (opts.modelProvider !== undefined) native.modelProvider = opts.modelProvider;
    if (opts.serviceTier != null) native.serviceTier = opts.serviceTier;
    if (opts.approvalPolicy !== undefined) native.approvalPolicy = opts.approvalPolicy;
    if (opts.sandbox !== undefined) native.sandbox = opts.sandbox;
    if (opts.serviceName !== undefined) native.serviceName = opts.serviceName;
    if (opts.config !== undefined) native.config = opts.config;
    if (opts.environments !== undefined) native.environments = opts.environments;
    if (opts.tools !== undefined) native.dynamicTools = opts.tools as DynamicToolSpec[];
    return this.startThreadNative(native);
  }

  /** Codex-native thread/start. */
  async startThreadNative(opts: CodexStartThreadOptions = {}): Promise<StartThreadResult> {
    const result = await this.owner.startThreadNative(opts);
    this.claim(result.threadId);
    return result;
  }

  async forkThread(opts: AgentForkThreadOptions): Promise<AgentBackendStartThreadResult> {
    const result = await this.owner.forkThread(opts);
    this.claim(result.threadId);
    return result;
  }

  async resumeThread(threadId: string): Promise<void> {
    this.claim(threadId);
    await this.owner.resumeThread(threadId);
  }

  async clearThreadGitInfo(threadId: string): Promise<void> {
    await this.owner.clearThreadGitInfo(threadId);
  }

  /** Neutral `AgentBackend.startTurn`. Maps text + image paths onto `UserInput[]`. */
  async startTurn(opts: AgentStartTurnOptions): Promise<{ turnId: string }> {
    const input: UserInput[] = [{ type: "text", text: opts.input.text, text_elements: [] }];
    for (const path of opts.input.imagePaths ?? []) input.push({ type: "localImage", path });
    const native: CodexStartTurnOptions = { threadId: opts.threadId, input };
    if (opts.reasoning !== undefined) native.effort = opts.reasoning;
    return this.startTurnNative(native);
  }

  /** Codex-native turn/start. */
  async startTurnNative(opts: CodexStartTurnOptions): Promise<{ turnId: string }> {
    // Claim the thread we're turning on — covers threads resumed from
    // persistence (the host never called startThread on this view for them).
    this.claim(opts.threadId);
    return this.owner.startTurnNative(opts);
  }

  async interruptTurn(threadId: string): Promise<void> {
    await this.owner.interruptTurn(threadId);
  }

  async archiveThread(threadId: string): Promise<void> {
    await this.owner.archiveThread(threadId);
    this.release(threadId);
  }

  /** Detach this view: drop handlers + release its threads from routing. Does
   *  NOT stop the shared process. Idempotent. */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.owner.detachView(this);
    this.eventListeners.clear();
    this.toolCallHandler = null;
    this.approvalHandler = null;
  }

  /** @internal */ ownedThreadIds(): ReadonlySet<string> {
    return this.ownedThreads;
  }

  private claim(threadId: string): void {
    this.ownedThreads.add(threadId);
    this.owner.registerThread(threadId, this);
  }

  private release(threadId: string): void {
    this.ownedThreads.delete(threadId);
    this.owner.unregisterThread(threadId, this);
  }
}

/**
 * Owns one Codex App Server process + connection and hands out per-surface
 * `CodexBackendView`s, model listing, and structured one-shot turns over the
 * single shared connection.
 */
export class CodexProcessOwner {
  private readonly requestTimeoutMs: number;
  private readonly turnTimeoutMs: number;
  private readonly logger: Logger;
  private readonly transportFactory: CodexTransportFactory | null;
  private resolvedCommand: string | null = null;
  private connection: JsonRpcConnection | null = null;
  private initializeResponse: InitializeResponse | null = null;

  // threadId → owning view, for routing notifications + server-requests.
  private readonly threadOwners = new Map<string, CodexBackendView>();
  private readonly views = new Set<CodexBackendView>();
  private readonly loadedThreadIds = new Set<string>();

  // one-shot worker-thread machinery (shares the connection).
  private pendingTurn: PendingOneShotTurn | null = null;
  private workerThread: WorkerThread | null = null;
  private oneShotQueue: Promise<void> = Promise.resolve();

  constructor(private readonly options: CodexProcessOwnerOptions = {}) {
    this.requestTimeoutMs = options.requestTimeoutMs ?? 20_000;
    this.turnTimeoutMs = options.turnTimeoutMs ?? 120_000;
    this.logger = options.logger ?? noopLogger;
    this.transportFactory = options.transportFactory ?? null;
  }

  /** Warm the process: spawn + `initialize` without opening any thread. Lets a
   *  pool hold an owner ready from startup. */
  async connect(): Promise<void> {
    await this.getConnection();
    await this.initialize();
  }

  /** Mint a lightweight per-surface backend. */
  createBackendView(): CodexBackendView {
    const view = new CodexBackendView(this);
    this.views.add(view);
    return view;
  }

  /** List available models over the shared connection. */
  async listModels(input: { includeHidden?: boolean } = {}): Promise<CodexModelOption[]> {
    const connection = await this.getConnection();
    await this.initialize();
    const models: CodexModelOption[] = [];
    let cursor: string | null = null;
    do {
      const response = (await connection.request(
        "model/list",
        { cursor, limit: 100, includeHidden: input.includeHidden ?? false },
        this.requestTimeoutMs
      )) as ModelListResponse;
      models.push(...response.data.map(modelToOption));
      cursor = response.nextCursor;
    } while (cursor !== null);
    return models;
  }

  /** Run one structured-output turn against a persistent worker thread on the
   *  shared connection. Calls are serialized — one in flight at a time. */
  async runOneShot(request: CodexOneShotRequest): Promise<CodexOneShotResponse> {
    const run = this.oneShotQueue.catch(() => undefined).then(() => this.runOneShotInner(request));
    this.oneShotQueue = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }

  async close(): Promise<void> {
    const connection = this.connection;
    const worker = this.workerThread;
    this.connection = null;
    this.initializeResponse = null;
    this.workerThread = null;
    this.oneShotQueue = Promise.resolve();
    this.threadOwners.clear();
    this.views.clear();
    this.loadedThreadIds.clear();
    if (connection) {
      if (worker) {
        await connection
          .request("thread/archive", { threadId: worker.threadId }, this.requestTimeoutMs)
          .catch((error: unknown) => {
            this.logger.warn("worker thread archive failed", {
              threadId: worker.threadId,
              error: error instanceof Error ? error.message : String(error)
            });
          });
      }
      await connection.close();
    }
  }

  // ---- view-driven thread ops (called by CodexBackendView) ----

  /** @internal */
  async startThreadNative(opts: CodexStartThreadOptions = {}): Promise<StartThreadResult> {
    const connection = await this.getConnection();
    await this.initialize();

    const params: ThreadStartParams = {
      experimentalRawEvents: false,
      persistExtendedHistory: false
    };
    if (opts.cwd !== undefined) params.cwd = opts.cwd;
    if (opts.model !== undefined) params.model = opts.model;
    if (opts.modelProvider !== undefined) params.modelProvider = opts.modelProvider;
    if (opts.serviceTier !== undefined) params.serviceTier = opts.serviceTier;
    if (opts.runtimeWorkspaceRoots !== undefined) {
      params.runtimeWorkspaceRoots = opts.runtimeWorkspaceRoots;
    }
    params.serviceName = opts.serviceName ?? this.options.serviceName ?? DEFAULT_SERVICE_NAME;
    if (opts.approvalPolicy !== undefined) params.approvalPolicy = opts.approvalPolicy as AskForApproval;
    if (opts.sandbox !== undefined) params.sandbox = opts.sandbox as SandboxMode;
    if (opts.baseInstructions !== undefined) params.baseInstructions = opts.baseInstructions;
    if (opts.personality !== undefined) params.personality = opts.personality as Personality;
    if (opts.dynamicTools !== undefined) params.dynamicTools = opts.dynamicTools;
    if (opts.config !== undefined) {
      params.config = opts.config as NonNullable<ThreadStartParams["config"]>;
    }
    if (opts.environments !== undefined) {
      params.environments = opts.environments as NonNullable<ThreadStartParams["environments"]>;
    }

    const response = (await connection.request(
      "thread/start",
      params,
      this.requestTimeoutMs
    )) as ThreadStartResponse;
    const threadId = response.thread.id;
    this.loadedThreadIds.add(threadId);
    this.logger.debug("thread started", { threadId });
    return {
      threadId,
      model: response.model,
      modelProvider: response.modelProvider,
      serviceTier: response.serviceTier
    };
  }

  /** @internal */
  async forkThread(opts: AgentForkThreadOptions): Promise<AgentBackendStartThreadResult> {
    const connection = await this.getConnection();
    await this.initialize();

    const params: ThreadForkParams = {
      threadId: opts.sourceThreadId,
      persistExtendedHistory: false
    };
    if (opts.cwd !== undefined) params.cwd = opts.cwd;
    if (opts.workspaceRoots !== undefined) params.runtimeWorkspaceRoots = [...opts.workspaceRoots];
    if (opts.instructions !== undefined) params.baseInstructions = opts.instructions;
    if (opts.approvalPolicy !== undefined) params.approvalPolicy = opts.approvalPolicy as AskForApproval;
    if (opts.sandbox !== undefined) params.sandbox = opts.sandbox as SandboxMode;
    if (opts.config !== undefined) {
      params.config = opts.config as NonNullable<ThreadForkParams["config"]>;
    }

    const response = (await connection.request(
      "thread/fork",
      params,
      this.requestTimeoutMs
    )) as ThreadForkResponse;
    const threadId = response.thread.id;
    this.loadedThreadIds.add(threadId);
    return {
      threadId,
      model: response.model,
      modelProvider: response.modelProvider,
      serviceTier: response.serviceTier
    };
  }

  /** @internal */
  async resumeThread(threadId: string): Promise<void> {
    if (this.loadedThreadIds.has(threadId)) return;
    const connection = await this.getConnection();
    await this.initialize();
    const params: ThreadResumeParams = { threadId, persistExtendedHistory: false };
    const response = (await connection.request(
      "thread/resume",
      params,
      this.requestTimeoutMs
    )) as ThreadResumeResponse;
    this.loadedThreadIds.add(response.thread.id);
    this.logger.debug("thread resumed", { threadId: response.thread.id });
  }

  /** @internal */
  async clearThreadGitInfo(threadId: string): Promise<void> {
    const connection = await this.getConnection();
    await this.initialize();
    await connection.request(
      "thread/metadata/update",
      { threadId, gitInfo: { sha: null, branch: null, originUrl: null } },
      this.requestTimeoutMs
    );
  }

  /** @internal */
  async startTurnNative(opts: CodexStartTurnOptions): Promise<{ turnId: string }> {
    await this.resumeThread(opts.threadId);
    const connection = await this.getConnection();
    await this.initialize();

    const params: TurnStartParams = { threadId: opts.threadId, input: opts.input };
    if (opts.effort !== undefined) params.effort = opts.effort as ReasoningEffort;

    const response = (await connection.request(
      "turn/start",
      params,
      this.turnTimeoutMs
    )) as TurnStartResponse;
    const turnId = response.turn.id;
    this.logger.debug("turn started", { threadId: opts.threadId, turnId });
    return { turnId };
  }

  /** @internal */
  async interruptTurn(threadId: string): Promise<void> {
    const connection = await this.getConnection();
    await connection.request("turn/interrupt", { threadId }, this.requestTimeoutMs);
  }

  /** @internal */
  async archiveThread(threadId: string): Promise<void> {
    const connection = await this.getConnection();
    await connection.request("thread/archive", { threadId }, this.requestTimeoutMs);
  }

  // ---- routing registration (called by CodexBackendView) ----

  /** @internal */ registerThread(threadId: string, view: CodexBackendView): void {
    this.threadOwners.set(threadId, view);
  }

  /** @internal */ unregisterThread(threadId: string, view: CodexBackendView): void {
    if (this.threadOwners.get(threadId) === view) this.threadOwners.delete(threadId);
  }

  /** @internal */ detachView(view: CodexBackendView): void {
    for (const threadId of view.ownedThreadIds()) {
      if (this.threadOwners.get(threadId) === view) this.threadOwners.delete(threadId);
    }
    this.views.delete(view);
  }

  // ---- connection / routing internals ----

  private async resolveCommand(): Promise<string> {
    if (this.resolvedCommand !== null) return this.resolvedCommand;
    const resolved = await resolveCodexCommand({
      command: this.options.command ?? "codex",
      env: this.options.env ?? process.env
    });
    this.resolvedCommand = resolved.command;
    return resolved.command;
  }

  private async initialize(): Promise<InitializeResponse> {
    if (this.initializeResponse) return this.initializeResponse;
    const connection = await this.getConnection();
    const name = this.options.clientName ?? DEFAULT_CLIENT_NAME;
    const params: InitializeParams = {
      clientInfo: {
        name,
        title: this.options.clientTitle ?? name,
        version: this.options.clientVersion ?? "0.0.0"
      },
      capabilities: {
        experimentalApi: true,
        // We don't proxy through OpenAI's edge attestation flow, so opting in
        // would add per-turn latency for an unused round-trip.
        requestAttestation: false
      }
    };
    const response = (await connection.request(
      "initialize",
      params,
      this.requestTimeoutMs
    )) as InitializeResponse;
    this.initializeResponse = response;
    return response;
  }

  private async getConnection(): Promise<JsonRpcConnection> {
    if (this.connection) return this.connection;

    let transport: JsonRpcTransport;
    if (this.transportFactory !== null) {
      transport = this.transportFactory(this.options.command ?? "codex");
    } else {
      const command = await this.resolveCommand();
      transport = new StdioJsonRpcTransport({
        command,
        args: ["app-server"],
        ...(this.options.env !== undefined ? { env: this.options.env } : {}),
        logger: this.logger
      });
    }

    const connection = new JsonRpcConnection(transport, this.requestTimeoutMs, undefined, {
      logger: this.logger,
      logContext: { owner: "codex-process-owner" }
    });
    connection.setNotificationHandler((method, params) => {
      this.handleNotification(method, params);
    });
    connection.setRequestHandler((method, params) => this.handleServerRequest(method, params));
    await connection.connect();
    this.connection = connection;
    return connection;
  }

  private handleNotification(method: string, params: unknown): void {
    // Feed the one-shot machinery first (raw); it only acts on its pending
    // worker turn and ignores everything else, so view threads pass through.
    this.consumeOneShotNotification(method, params);

    const event = normalizeNotification(method, params);
    if (event === null) return;
    const threadId = eventThreadId(event);
    if (threadId === undefined) {
      // Connection-level event (e.g. a threadless error) — broadcast to all views.
      for (const view of this.views) view.emit(event);
      return;
    }
    const view = this.threadOwners.get(threadId);
    // No owning view → the worker thread, or a stale/raced thread. Drop it: the
    // worker thread's stream is consumed above and must never leak to a surface.
    if (view) view.emit(event);
  }

  private async handleServerRequest(method: string, params: unknown): Promise<unknown> {
    const threadId = requestThreadId(params);
    const view = threadId !== undefined ? this.threadOwners.get(threadId) : undefined;

    if (method === CODEX_TOOL_CALL_METHOD) {
      const handler = view?.toolCallHandler;
      if (!handler) {
        this.logger.warn("tool call received with no handler for thread", { threadId });
        return noToolHandlerResponse();
      }
      const call: AgentBackendToolCall = { method, params };
      return await handler(call);
    }

    if (CODEX_APPROVAL_METHODS.has(method)) {
      const handler = view?.approvalHandler;
      if (!handler) {
        this.logger.warn("approval request received with no handler for thread", {
          method,
          threadId
        });
        return approvalResponseFor("denied");
      }
      const decision = await handler(method, params);
      return approvalResponseFor(decision);
    }

    this.logger.debug("unhandled codex server request", { method });
    return {};
  }

  // ---- one-shot worker-thread machinery ----

  private async runOneShotInner(request: CodexOneShotRequest): Promise<CodexOneShotResponse> {
    const connection = await this.getConnection();
    const initialized = await this.initialize();
    let thread: WorkerThread | null = null;
    let turnId: string | null = null;
    let rolledBack = false;
    let aborted = false;

    const abortHandler = (): void => {
      aborted = true;
      if (thread && turnId) {
        void connection
          .request("turn/interrupt", { threadId: thread.threadId, turnId }, this.requestTimeoutMs)
          .catch((error: unknown) => {
            this.logger.warn("turn interrupt failed", {
              error: error instanceof Error ? error.message : String(error)
            });
          });
      }
    };

    request.abortSignal?.addEventListener("abort", abortHandler, { once: true });

    try {
      if (request.abortSignal?.aborted) {
        throw new DOMException("one-shot turn aborted", "AbortError");
      }

      thread = await this.getWorkerThread(
        request.model ?? null,
        request.modelProvider ?? null,
        request.baseInstructions ?? ""
      );

      const input: UserInput[] = [
        { type: "text", text: request.prompt, text_elements: [] },
        ...imagePathsToLocalImageInputs(request.imagePaths ?? [])
      ];

      const turnResponse = (await connection.request(
        "turn/start",
        {
          threadId: thread.threadId,
          model: request.model ?? null,
          input,
          effort: request.effort ?? "low",
          ...(request.outputSchema !== undefined ? { outputSchema: request.outputSchema } : {})
        },
        this.requestTimeoutMs
      )) as TurnStartResponse;
      turnId = turnResponse.turn.id;

      if (request.abortSignal?.aborted || aborted) {
        throw new DOMException("one-shot turn aborted", "AbortError");
      }

      const { rawText, tokenUsage } = await this.waitForOneShotTurn(thread.threadId, turnId);
      await this.rollbackWorkerThread(thread.threadId);
      rolledBack = true;
      return {
        rawText,
        threadId: thread.threadId,
        turnId,
        userAgent: initialized.userAgent,
        model: thread.model,
        modelProvider: thread.modelProvider,
        serviceTier: thread.serviceTier,
        tokenUsage: tokenUsage === null ? null : normalizeTokenUsage(tokenUsage)
      };
    } finally {
      request.abortSignal?.removeEventListener("abort", abortHandler);
      if (thread && turnId && !rolledBack) {
        await this.rollbackWorkerThread(thread.threadId).catch((error: unknown) => {
          this.logger.warn("worker thread rollback failed", {
            threadId: thread?.threadId,
            error: error instanceof Error ? error.message : String(error)
          });
        });
      }
    }
  }

  private async getWorkerThread(
    model: string | null,
    modelProvider: string | null,
    baseInstructions: string
  ): Promise<WorkerThread> {
    const modelKey = `${model ?? "__default__"}@${modelProvider ?? "__default__"}::${baseInstructions}`;
    if (this.workerThread?.modelKey === modelKey) return this.workerThread;
    if (this.workerThread) {
      const stale = this.workerThread;
      this.workerThread = null;
      const connection = await this.getConnection();
      await connection
        .request("thread/archive", { threadId: stale.threadId }, this.requestTimeoutMs)
        .catch((error: unknown) => {
          this.logger.warn("thread archive failed", {
            threadId: stale.threadId,
            error: error instanceof Error ? error.message : String(error)
          });
        });
    }

    const connection = await this.getConnection();
    const workspaceDir = await this.prepareWorkerWorkspace();
    const threadResponse = (await connection.request(
      "thread/start",
      {
        model,
        ...(modelProvider !== null ? { modelProvider } : {}),
        ephemeral: false,
        cwd: workspaceDir,
        runtimeWorkspaceRoots: [workspaceDir],
        serviceName: this.options.serviceName ?? DEFAULT_SERVICE_NAME,
        approvalPolicy: "never",
        sandbox: "read-only",
        ...(baseInstructions.length > 0 ? { baseInstructions } : {}),
        // Persistent worker thread for a prompt-cache experiment: keep the thread
        // id stable across requests, then roll back each turn. The dedicated cwd
        // keeps the worker out of any host repo/worktree.
        ...(this.options.worker?.threadConfig !== undefined
          ? { config: this.options.worker.threadConfig }
          : {}),
        environments: [],
        experimentalRawEvents: false,
        persistExtendedHistory: false
      },
      this.requestTimeoutMs
    )) as ThreadStartResponse;
    await this.clearWorkerThreadGitInfo(threadResponse.thread.id);
    await this.setWorkerThreadName(threadResponse.thread.id);
    this.workerThread = {
      threadId: threadResponse.thread.id,
      modelKey,
      baseInstructions,
      model: threadResponse.model,
      modelProvider: threadResponse.modelProvider,
      serviceTier: threadResponse.serviceTier
    };
    return this.workerThread;
  }

  private async rollbackWorkerThread(threadId: string): Promise<void> {
    const connection = await this.getConnection();
    await connection.request("thread/rollback", { threadId, numTurns: 1 }, this.requestTimeoutMs);
  }

  private async prepareWorkerWorkspace(): Promise<string> {
    const workspaceDir =
      this.options.worker?.workspaceDir ?? join(tmpdir(), "agent-kit", "oneshot-worker");
    await mkdir(workspaceDir, { recursive: true });
    return workspaceDir;
  }

  private async clearWorkerThreadGitInfo(threadId: string): Promise<void> {
    const connection = await this.getConnection();
    await connection
      .request(
        "thread/metadata/update",
        { threadId, gitInfo: { sha: null, branch: null, originUrl: null } },
        this.requestTimeoutMs
      )
      .catch((error: unknown) => {
        this.logger.warn("thread git metadata clear failed", {
          threadId,
          error: error instanceof Error ? error.message : String(error)
        });
      });
  }

  private async setWorkerThreadName(threadId: string): Promise<void> {
    const connection = await this.getConnection();
    await connection
      .request(
        "thread/name/set",
        { threadId, name: this.options.worker?.threadName ?? "agent-kit One-Shot Worker" },
        this.requestTimeoutMs
      )
      .catch((error: unknown) => {
        this.logger.warn("worker thread name set failed", {
          threadId,
          error: error instanceof Error ? error.message : String(error)
        });
      });
  }

  private waitForOneShotTurn(
    threadId: string,
    turnId: string
  ): Promise<{ rawText: string; tokenUsage: ThreadTokenUsage | null }> {
    if (this.pendingTurn) {
      throw new Error("codex one-shot already has an active turn");
    }
    return new Promise<{ rawText: string; tokenUsage: ThreadTokenUsage | null }>(
      (resolve, reject) => {
        const timer = setTimeout(() => {
          this.pendingTurn = null;
          reject(new Error("codex one-shot turn timed out"));
        }, this.turnTimeoutMs);
        this.pendingTurn = {
          threadId,
          turnId,
          agentMessages: [],
          tokenUsage: null,
          resolve,
          reject,
          timer
        };
      }
    );
  }

  private consumeOneShotNotification(method: string, params: unknown): void {
    if (this.pendingTurn === null) return;
    if (method === "item/completed") {
      this.onOneShotItemCompleted(params as ItemCompletedNotification);
    } else if (method === "rawResponseItem/completed") {
      this.onOneShotRawResponseItemCompleted(params as ServerNotification["params"]);
    } else if (method === "thread/tokenUsage/updated") {
      this.onOneShotTokenUsage(params as ThreadTokenUsageUpdatedNotification);
    } else if (method === "turn/completed") {
      this.onOneShotTurnCompleted(params as TurnCompletedNotification);
    }
  }

  private onOneShotItemCompleted(params: ItemCompletedNotification): void {
    const pending = this.pendingTurn;
    if (!pending || params.threadId !== pending.threadId || params.turnId !== pending.turnId) return;
    if (params.item.type === "agentMessage") pending.agentMessages.push(params.item.text);
  }

  private onOneShotRawResponseItemCompleted(params: ServerNotification["params"]): void {
    const pending = this.pendingTurn;
    if (!pending || typeof params !== "object" || params === null) return;
    const maybe = params as { threadId?: unknown; turnId?: unknown; item?: ResponseItem };
    if (maybe.threadId !== pending.threadId || maybe.turnId !== pending.turnId) return;
    const item = maybe.item;
    if (item?.type !== "message" || item.role !== "assistant") return;
    const text = item.content
      .filter((content) => content.type === "output_text")
      .map((content) => content.text)
      .join("");
    if (text) pending.agentMessages.push(text);
  }

  private onOneShotTokenUsage(params: ThreadTokenUsageUpdatedNotification): void {
    const pending = this.pendingTurn;
    if (!pending || params.threadId !== pending.threadId || params.turnId !== pending.turnId) return;
    pending.tokenUsage = params.tokenUsage;
  }

  private onOneShotTurnCompleted(params: TurnCompletedNotification): void {
    const pending = this.pendingTurn;
    if (!pending || params.threadId !== pending.threadId || params.turn.id !== pending.turnId) return;

    clearTimeout(pending.timer);
    this.pendingTurn = null;

    if (params.turn.status === "failed") {
      pending.reject(new Error(params.turn.error?.message ?? "codex one-shot turn failed"));
      return;
    }
    if (params.turn.status === "interrupted") {
      pending.reject(new DOMException("one-shot turn aborted", "AbortError"));
      return;
    }
    const rawText = pending.agentMessages.at(-1)?.trim();
    if (!rawText) {
      pending.reject(new Error("codex one-shot turn returned no assistant message"));
      return;
    }
    pending.resolve({ rawText, tokenUsage: pending.tokenUsage });
  }
}
