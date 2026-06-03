// One-shot Codex App Server client for structured-output enrichment turns.
//
// Drives a single short turn against a persistent worker thread: build a turn
// with caller-supplied prompt + JSON Schema (`outputSchema`), feed optional
// local images as file-path inputs, refuse any tool calls, await the assistant
// message, then `thread/rollback` the turn so the worker thread stays clean for
// the next request (a prompt-cache experiment from PwrSnap).
//
// Ported from PwrSnap's CodexAppServerClient with the product specifics removed:
//   • the prompt + JSON Schema + base instructions are CALLER-SUPPLIED per
//     request (no CAPTURE_ENRICHMENT_SCHEMA / capture prompt baked in);
//   • the logger is injected (agent-core `Logger`);
//   • identity (`clientInfo.name`, default `serviceName`) is parameterized;
//   • the binary is resolved via codex-discovery and spawned `["app-server"]`.
//
// The result is the RAW assistant text plus token usage — parsing/validating
// the JSON against the caller's schema is the caller's job.

import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  noopLogger,
  type Logger,
  type NormalizedTokenUsage
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
  ResponseItem,
  ServerNotification
} from "@pwrdrvr/codex-app-server-protocol";
import type {
  DynamicToolCallResponse,
  ItemCompletedNotification,
  Model,
  ModelListResponse,
  ThreadStartResponse,
  ThreadTokenUsage,
  ThreadTokenUsageUpdatedNotification,
  TurnCompletedNotification,
  TurnStartResponse,
  UserInput
} from "@pwrdrvr/codex-app-server-protocol/v2";
import { normalizeTokenUsage } from "./normalize";

export type CodexOneShotTransportFactory = (command: string) => JsonRpcTransport;

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

export type CodexOneShotClientOptions = {
  command?: string;
  /** Identity sent as `clientInfo.name`. Defaults to "agent-kit". */
  clientName?: string;
  clientTitle?: string;
  clientVersion?: string;
  /** serviceName for the worker thread. Defaults to "agent-kit". */
  serviceName?: string;
  /** Working dir for the persistent worker thread (keeps it out of any repo). */
  workspaceDir?: string;
  /** Human-readable name set on the worker thread. */
  workerThreadName?: string;
  /** Per-thread Codex config overlay applied to the worker thread. */
  threadConfig?: Record<string, unknown>;
  requestTimeoutMs?: number;
  turnTimeoutMs?: number;
  env?: NodeJS.ProcessEnv;
  transportFactory?: CodexOneShotTransportFactory;
  logger?: Logger;
};

export type CodexOneShotRequest = {
  /** The user-message text (the caller's prompt) for this turn. */
  prompt: string;
  /** Local image file paths fed as `localImage` inputs (not inlined as base64). */
  imagePaths?: readonly string[];
  /** JSON Schema constraining the final assistant message (`outputSchema`). */
  outputSchema?: unknown;
  /** Base instructions for the worker thread (set once; changing it re-creates
   *  the worker thread). */
  baseInstructions?: string;
  /** Reasoning effort for the turn. Defaults to "low". */
  effort?: string;
  model?: string | null;
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

type PendingTurn = {
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

const DEFAULT_CLIENT_NAME = "agent-kit";
const DEFAULT_SERVICE_NAME = "agent-kit";

export class CodexOneShotClient {
  private readonly requestTimeoutMs: number;
  private readonly turnTimeoutMs: number;
  private readonly logger: Logger;
  private readonly transportFactory: CodexOneShotTransportFactory | null;
  private resolvedCommand: string | null = null;
  private connection: JsonRpcConnection | null = null;
  private initializeResponse: InitializeResponse | null = null;
  private pendingTurn: PendingTurn | null = null;
  private workerThread: WorkerThread | null = null;
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly options: CodexOneShotClientOptions = {}) {
    this.requestTimeoutMs = options.requestTimeoutMs ?? 20_000;
    this.turnTimeoutMs = options.turnTimeoutMs ?? 120_000;
    this.logger = options.logger ?? noopLogger;
    this.transportFactory = options.transportFactory ?? null;
  }

  /** Run one structured-output turn. Calls are serialized — only one turn is in
   *  flight at a time against the shared worker thread. */
  async run(request: CodexOneShotRequest): Promise<CodexOneShotResponse> {
    const run = this.queue.catch(() => undefined).then(() => this.runInner(request));
    this.queue = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }

  private async runInner(request: CodexOneShotRequest): Promise<CodexOneShotResponse> {
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

      const { rawText, tokenUsage } = await this.waitForTurn(thread.threadId, turnId);
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

  async close(): Promise<void> {
    const connection = this.connection;
    const thread = this.workerThread;
    this.connection = null;
    this.initializeResponse = null;
    this.workerThread = null;
    this.queue = Promise.resolve();
    if (connection) {
      if (thread) {
        await connection
          .request("thread/archive", { threadId: thread.threadId }, this.requestTimeoutMs)
          .catch((error: unknown) => {
            this.logger.warn("thread archive failed", {
              threadId: thread.threadId,
              error: error instanceof Error ? error.message : String(error)
            });
          });
      }
      await connection.close();
    }
  }

  // ---- worker-thread management ----

  private async getWorkerThread(
    model: string | null,
    baseInstructions: string
  ): Promise<WorkerThread> {
    const modelKey = `${model ?? "__default__"}::${baseInstructions}`;
    if (this.workerThread?.modelKey === modelKey) {
      return this.workerThread;
    }
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
    const workspaceDir = await this.prepareWorkspace();
    const threadResponse = (await connection.request(
      "thread/start",
      {
        model,
        ephemeral: false,
        cwd: workspaceDir,
        runtimeWorkspaceRoots: [workspaceDir],
        serviceName: this.options.serviceName ?? DEFAULT_SERVICE_NAME,
        approvalPolicy: "never",
        sandbox: "read-only",
        ...(baseInstructions.length > 0 ? { baseInstructions } : {}),
        // Persistent worker thread for a prompt-cache experiment: keep the
        // thread id stable across requests, then roll back each turn. The
        // dedicated cwd keeps the worker out of any host repo/worktree.
        ...(this.options.threadConfig !== undefined ? { config: this.options.threadConfig } : {}),
        environments: [],
        experimentalRawEvents: false,
        persistExtendedHistory: false
      },
      this.requestTimeoutMs
    )) as ThreadStartResponse;
    await this.clearThreadGitInfo(threadResponse.thread.id);
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

  private async prepareWorkspace(): Promise<string> {
    const workspaceDir =
      this.options.workspaceDir ?? join(tmpdir(), "agent-kit", "oneshot-worker");
    await mkdir(workspaceDir, { recursive: true });
    return workspaceDir;
  }

  private async clearThreadGitInfo(threadId: string): Promise<void> {
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
        { threadId, name: this.options.workerThreadName ?? "agent-kit One-Shot Worker" },
        this.requestTimeoutMs
      )
      .catch((error: unknown) => {
        this.logger.warn("worker thread name set failed", {
          threadId,
          error: error instanceof Error ? error.message : String(error)
        });
      });
  }

  // ---- connection / turn plumbing ----

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
      logContext: { owner: "codex-oneshot-client" }
    });
    connection.setNotificationHandler((method, params) => {
      this.handleNotification(method, params);
    });
    connection.setRequestHandler((method, params) => this.handleServerRequest(method, params));
    await connection.connect();
    this.connection = connection;
    return connection;
  }

  private waitForTurn(
    threadId: string,
    turnId: string
  ): Promise<{ rawText: string; tokenUsage: ThreadTokenUsage | null }> {
    if (this.pendingTurn) {
      throw new Error("codex one-shot client already has an active turn");
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

  private handleNotification(method: string, params: unknown): void {
    if (method === "item/completed") {
      this.handleItemCompleted(params as ItemCompletedNotification);
      return;
    }
    if (method === "rawResponseItem/completed") {
      this.handleRawResponseItemCompleted(params as ServerNotification["params"]);
      return;
    }
    if (method === "thread/tokenUsage/updated") {
      this.handleThreadTokenUsageUpdated(params as ThreadTokenUsageUpdatedNotification);
      return;
    }
    if (method === "turn/completed") {
      this.handleTurnCompleted(params as TurnCompletedNotification);
    }
  }

  private handleItemCompleted(params: ItemCompletedNotification): void {
    const pending = this.pendingTurn;
    if (!pending || params.threadId !== pending.threadId || params.turnId !== pending.turnId) {
      return;
    }
    if (params.item.type === "agentMessage") {
      pending.agentMessages.push(params.item.text);
    }
  }

  private handleRawResponseItemCompleted(params: ServerNotification["params"]): void {
    const pending = this.pendingTurn;
    if (!pending || typeof params !== "object" || params === null) {
      return;
    }
    const maybe = params as { threadId?: unknown; turnId?: unknown; item?: ResponseItem };
    if (maybe.threadId !== pending.threadId || maybe.turnId !== pending.turnId) {
      return;
    }
    const item = maybe.item;
    if (item?.type !== "message" || item.role !== "assistant") {
      return;
    }
    const text = item.content
      .filter((content) => content.type === "output_text")
      .map((content) => content.text)
      .join("");
    if (text) {
      pending.agentMessages.push(text);
    }
  }

  private handleTurnCompleted(params: TurnCompletedNotification): void {
    const pending = this.pendingTurn;
    if (!pending || params.threadId !== pending.threadId || params.turn.id !== pending.turnId) {
      return;
    }

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

  private handleThreadTokenUsageUpdated(params: ThreadTokenUsageUpdatedNotification): void {
    const pending = this.pendingTurn;
    if (!pending || params.threadId !== pending.threadId || params.turnId !== pending.turnId) {
      return;
    }
    pending.tokenUsage = params.tokenUsage;
  }

  private async handleServerRequest(method: string, _params: unknown): Promise<unknown> {
    if (method === "item/tool/call") {
      // One-shot enrichment exposes no tools — refuse any tool call.
      return {
        contentItems: [
          { type: "inputText", text: "This one-shot run does not expose tools." }
        ],
        success: false
      } satisfies DynamicToolCallResponse;
    }
    this.logger.debug("unhandled codex server request", { method });
    return {};
  }
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
