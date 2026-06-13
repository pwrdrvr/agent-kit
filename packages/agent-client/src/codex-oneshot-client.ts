// One-shot Codex App Server client for structured-output enrichment turns.
//
// Now a THIN SHIM over `CodexProcessOwner.runOneShot()` / `.listModels()`: it
// owns one Codex process and drives short structured turns against a persistent
// worker thread (build a turn with caller-supplied prompt + JSON Schema
// `outputSchema`, feed optional local images as file-path inputs, refuse any
// tool call, await the assistant message, then `thread/rollback` the turn so the
// worker thread stays clean for the next request — a prompt-cache experiment).
//
// The result is the RAW assistant text plus token usage — parsing/validating the
// JSON against the caller's schema is the caller's job.
//
// When a host already has a pooled `CodexProcessOwner` for chat, prefer
// `owner.runOneShot()` / `owner.listModels()` directly so enrichment + the model
// picker ride the SAME process instead of spawning this standalone one.

import {
  type Logger
} from "@pwrdrvr/agent-core";
import {
  CodexProcessOwner,
  type CodexProcessOwnerOptions,
  type CodexModelOption,
  type CodexOneShotRequest,
  type CodexOneShotResponse,
  type CodexTransportFactory
} from "./codex-process-owner";

export type CodexOneShotTransportFactory = CodexTransportFactory;

// Re-exported from the owner (the source of truth).
export type {
  CodexModelOption,
  CodexOneShotRequest,
  CodexOneShotResponse
} from "./codex-process-owner";

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

/** Translate the one-shot options into owner options (folding the worker config
 *  under `owner.worker`). */
function toOwnerOptions(options: CodexOneShotClientOptions): CodexProcessOwnerOptions {
  const owner: CodexProcessOwnerOptions = {};
  if (options.command !== undefined) owner.command = options.command;
  if (options.clientName !== undefined) owner.clientName = options.clientName;
  if (options.clientTitle !== undefined) owner.clientTitle = options.clientTitle;
  if (options.clientVersion !== undefined) owner.clientVersion = options.clientVersion;
  if (options.serviceName !== undefined) owner.serviceName = options.serviceName;
  if (options.requestTimeoutMs !== undefined) owner.requestTimeoutMs = options.requestTimeoutMs;
  if (options.turnTimeoutMs !== undefined) owner.turnTimeoutMs = options.turnTimeoutMs;
  if (options.env !== undefined) owner.env = options.env;
  if (options.transportFactory !== undefined) owner.transportFactory = options.transportFactory;
  if (options.logger !== undefined) owner.logger = options.logger;
  const worker: NonNullable<CodexProcessOwnerOptions["worker"]> = {};
  if (options.workspaceDir !== undefined) worker.workspaceDir = options.workspaceDir;
  if (options.workerThreadName !== undefined) worker.threadName = options.workerThreadName;
  if (options.threadConfig !== undefined) worker.threadConfig = options.threadConfig;
  if (Object.keys(worker).length > 0) owner.worker = worker;
  return owner;
}

export class CodexOneShotClient {
  private readonly owner: CodexProcessOwner;

  constructor(options: CodexOneShotClientOptions = {}) {
    this.owner = new CodexProcessOwner(toOwnerOptions(options));
  }

  /** Run one structured-output turn. Calls are serialized — only one turn is in
   *  flight at a time against the shared worker thread. */
  async run(request: CodexOneShotRequest): Promise<CodexOneShotResponse> {
    return this.owner.runOneShot(request);
  }

  async listModels(input: { includeHidden?: boolean } = {}): Promise<CodexModelOption[]> {
    return this.owner.listModels(input);
  }

  async close(): Promise<void> {
    await this.owner.close();
  }
}
