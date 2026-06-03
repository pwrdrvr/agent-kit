// Long-lived, multi-turn Codex App Server client.
//
// Keeps a single codex child process + JSON-RPC connection alive and lets the
// caller open MULTIPLE threads on it, each carrying its own dynamic tools. It
// is a thin transport client: it owns the connection lifecycle and routes
// notifications / server-requests, but bakes in no chat or idle-timing logic.
//
// Ported from PwrSnap's CodexThreadClient with three seams broken:
//   • the logger is injected (agent-core `Logger`);
//   • `clientInfo.name` + the default `serviceName` are options (no hardcoded
//     "pwrsnap");
//   • every native notification is routed through `normalizeNotification`, so
//     subscribers receive agent-core `NormalizedThreadEvent` — never a raw
//     protocol shape.

import {
  noopLogger,
  type Logger,
  type NormalizedThreadEvent,
  type NormalizedApprovalDecision
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
  ReasoningEffort
} from "@pwrdrvr/codex-app-server-protocol";
import type {
  AskForApproval,
  DynamicToolCallParams,
  DynamicToolCallResponse,
  DynamicToolSpec,
  SandboxMode,
  ThreadResumeParams,
  ThreadResumeResponse,
  ThreadStartParams,
  ThreadStartResponse,
  TurnStartParams,
  TurnStartResponse,
  UserInput
} from "@pwrdrvr/codex-app-server-protocol/v2";
import {
  CODEX_APPROVAL_METHODS,
  CODEX_TOOL_CALL_METHOD,
  normalizeNotification
} from "./normalize";

export type CodexThreadClientTransportFactory = (command: string) => JsonRpcTransport;

export type CodexThreadClientOptions = {
  /** Configured command to resolve. `"codex"` (or empty) triggers discovery. */
  command?: string;
  /** Identity sent as `clientInfo.name` at `initialize`. Defaults to "agent-kit". */
  clientName?: string;
  /** Human title sent as `clientInfo.title`. Defaults to `clientName`. */
  clientTitle?: string;
  /** Version sent as `clientInfo.version`. Defaults to "0.0.0". */
  clientVersion?: string;
  /** Default `serviceName` applied at `thread/start` when the caller omits one. */
  serviceName?: string;
  requestTimeoutMs?: number;
  turnTimeoutMs?: number;
  /** Process env passed to the spawned codex. Defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
  /** Override the transport (tests inject an in-memory fake). When supplied,
   *  no discovery/spawn happens. */
  transportFactory?: CodexThreadClientTransportFactory;
  logger?: Logger;
};

export type CodexStartThreadOptions = {
  approvalPolicy?: string;
  sandbox?: string;
  baseInstructions?: string;
  dynamicTools?: DynamicToolSpec[];
  cwd?: string;
  runtimeWorkspaceRoots?: string[];
  serviceName?: string;
  personality?: string;
  /** Per-thread Codex config overlay (the `-c key=value` mechanism). Used to
   *  disable Codex prompt/tool scaffolding that belongs to coding-agent threads. */
  config?: Record<string, unknown>;
  /** Thread environments. **Empty array disables exec-environment access**,
   *  dropping Codex's built-in shell / unified_exec / apply_patch tools. Dynamic
   *  tools are added before that gate, so they survive. */
  environments?: unknown[];
};

export type CodexStartTurnOptions = {
  threadId: string;
  input: UserInput[];
  effort?: string;
};

/** Handles a dynamic tool ServerRequest; returns the protocol response. */
export type CodexToolCallHandler = (
  params: DynamicToolCallParams
) => Promise<DynamicToolCallResponse>;

/** Handles an approval ServerRequest; resolves to a neutral decision. */
export type CodexApprovalHandler = (
  method: string,
  params: unknown
) => Promise<NormalizedApprovalDecision>;

export type Unsubscribe = () => void;

export type StartThreadResult = {
  threadId: string;
  model: string;
  modelProvider: string;
  serviceTier: string | null;
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

export class CodexThreadClient {
  private readonly requestTimeoutMs: number;
  private readonly turnTimeoutMs: number;
  private readonly logger: Logger;
  private readonly transportFactory: CodexThreadClientTransportFactory | null;
  private resolvedCommand: string | null = null;
  private connection: JsonRpcConnection | null = null;
  private initializeResponse: InitializeResponse | null = null;

  private readonly eventListeners = new Set<(event: NormalizedThreadEvent) => void>();
  private toolCallHandler: CodexToolCallHandler | null = null;
  private approvalHandler: CodexApprovalHandler | null = null;
  private readonly loadedThreadIds = new Set<string>();

  constructor(private readonly options: CodexThreadClientOptions = {}) {
    this.requestTimeoutMs = options.requestTimeoutMs ?? 20_000;
    this.turnTimeoutMs = options.turnTimeoutMs ?? 120_000;
    this.logger = options.logger ?? noopLogger;
    this.transportFactory = options.transportFactory ?? null;
  }

  /** Subscribe to the normalized event stream. Every native notification is
   *  routed through `normalizeNotification` before listeners see it. */
  onEvent(cb: (event: NormalizedThreadEvent) => void): Unsubscribe {
    this.eventListeners.add(cb);
    return () => {
      this.eventListeners.delete(cb);
    };
  }

  /** Register the dynamic-tool ServerRequest handler (one at a time). */
  onToolCall(handler: CodexToolCallHandler): Unsubscribe {
    this.toolCallHandler = handler;
    return () => {
      if (this.toolCallHandler === handler) this.toolCallHandler = null;
    };
  }

  /** Register the approval ServerRequest handler (one at a time). */
  onApprovalRequest(handler: CodexApprovalHandler): Unsubscribe {
    this.approvalHandler = handler;
    return () => {
      if (this.approvalHandler === handler) this.approvalHandler = null;
    };
  }

  async startThread(opts: CodexStartThreadOptions = {}): Promise<StartThreadResult> {
    const connection = await this.getConnection();
    await this.initialize();

    // exactOptionalPropertyTypes: only attach a key when the caller supplied it.
    const params: ThreadStartParams = {
      experimentalRawEvents: false,
      persistExtendedHistory: false
    };
    if (opts.cwd !== undefined) params.cwd = opts.cwd;
    if (opts.runtimeWorkspaceRoots !== undefined) {
      params.runtimeWorkspaceRoots = opts.runtimeWorkspaceRoots;
    }
    const serviceName = opts.serviceName ?? this.options.serviceName ?? DEFAULT_SERVICE_NAME;
    params.serviceName = serviceName;
    if (opts.approvalPolicy !== undefined) {
      params.approvalPolicy = opts.approvalPolicy as AskForApproval;
    }
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

  async resumeThread(threadId: string): Promise<void> {
    if (this.loadedThreadIds.has(threadId)) return;
    const connection = await this.getConnection();
    await this.initialize();

    const params: ThreadResumeParams = {
      threadId,
      persistExtendedHistory: false
    };
    const response = (await connection.request(
      "thread/resume",
      params,
      this.requestTimeoutMs
    )) as ThreadResumeResponse;
    this.loadedThreadIds.add(response.thread.id);
    this.logger.debug("thread resumed", { threadId: response.thread.id });
  }

  async clearThreadGitInfo(threadId: string): Promise<void> {
    const connection = await this.getConnection();
    await this.initialize();
    await connection.request(
      "thread/metadata/update",
      { threadId, gitInfo: { sha: null, branch: null, originUrl: null } },
      this.requestTimeoutMs
    );
  }

  async startTurn(opts: CodexStartTurnOptions): Promise<{ turnId: string }> {
    await this.resumeThread(opts.threadId);
    const connection = await this.getConnection();
    await this.initialize();

    const params: TurnStartParams = {
      threadId: opts.threadId,
      input: opts.input
    };
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

  async interruptTurn(threadId: string): Promise<void> {
    const connection = await this.getConnection();
    await connection.request("turn/interrupt", { threadId }, this.requestTimeoutMs);
  }

  async archiveThread(threadId: string): Promise<void> {
    const connection = await this.getConnection();
    await connection.request("thread/archive", { threadId }, this.requestTimeoutMs);
  }

  async close(): Promise<void> {
    const connection = this.connection;
    this.connection = null;
    this.initializeResponse = null;
    this.loadedThreadIds.clear();
    if (connection) await connection.close();
  }

  // ---- internals ----

  private emit(event: NormalizedThreadEvent): void {
    for (const listener of this.eventListeners) listener(event);
  }

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
      // Tests / hosts supplying a fake transport bypass discovery + spawn.
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
      logContext: { owner: "codex-thread-client" }
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
    const event = normalizeNotification(method, params);
    if (event !== null) this.emit(event);
  }

  private async handleServerRequest(method: string, params: unknown): Promise<unknown> {
    if (method === CODEX_TOOL_CALL_METHOD) {
      const handler = this.toolCallHandler;
      if (!handler) {
        this.logger.warn("tool call received with no handler registered");
        return {
          contentItems: [
            { type: "inputText", text: "No tool handler is registered for this thread." }
          ],
          success: false
        } satisfies DynamicToolCallResponse;
      }
      return await handler(params as DynamicToolCallParams);
    }

    if (CODEX_APPROVAL_METHODS.has(method)) {
      const handler = this.approvalHandler;
      if (!handler) {
        this.logger.warn("approval request received with no handler registered", { method });
        return approvalResponseFor("denied");
      }
      const decision = await handler(method, params);
      return approvalResponseFor(decision);
    }

    this.logger.debug("unhandled codex server request", { method });
    return {};
  }
}
