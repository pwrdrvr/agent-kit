// Long-lived, multi-turn Codex App Server client.
//
// Now a THIN SHIM over `CodexProcessOwner` + a single `CodexBackendView`: it
// owns one Codex process and exposes one backend whose threads all route to its
// own handlers — exactly the long-standing behavior (a single global
// `onToolCall` / `onApprovalRequest` slot shared by every thread it opens).
//
// Reach for `CodexProcessOwner.createBackendView()` directly when MULTIPLE chat
// surfaces must share one Codex process with INDEPENDENT handlers — that's the
// per-surface routing `CodexThreadClient`'s single-view shape can't give you.

import {
  type AgentBackend,
  type AgentBackendStartThreadResult,
  type AgentForkThreadOptions,
  type AgentStartThreadOptions,
  type AgentStartTurnOptions,
  type Logger,
  type NormalizedThreadEvent
} from "@pwrdrvr/agent-core";
import {
  CodexBackendView,
  CodexProcessOwner,
  type CodexProcessOwnerOptions,
  type CodexStartThreadOptions,
  type CodexStartTurnOptions,
  type CodexToolCallHandler,
  type CodexApprovalHandler,
  type CodexTransportFactory,
  type StartThreadResult,
  type Unsubscribe
} from "./codex-process-owner";

export type CodexThreadClientTransportFactory = CodexTransportFactory;

// Re-exported from the owner (the source of truth) so existing imports from
// `./codex-thread-client` keep resolving.
export type {
  CodexStartThreadOptions,
  CodexStartTurnOptions,
  CodexToolCallHandler,
  CodexApprovalHandler,
  StartThreadResult,
  Unsubscribe
} from "./codex-process-owner";

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
  /** Override the transport (tests inject an in-memory fake). When supplied, no
   *  discovery/spawn happens. */
  transportFactory?: CodexThreadClientTransportFactory;
  logger?: Logger;
};

/** Translate the (additive) thread-client options into owner options. */
function toOwnerOptions(options: CodexThreadClientOptions): CodexProcessOwnerOptions {
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
  return owner;
}

export class CodexThreadClient implements AgentBackend {
  private readonly owner: CodexProcessOwner;
  private readonly view: CodexBackendView;

  constructor(options: CodexThreadClientOptions = {}) {
    this.owner = new CodexProcessOwner(toOwnerOptions(options));
    this.view = this.owner.createBackendView();
  }

  onEvent(cb: (event: NormalizedThreadEvent) => void): Unsubscribe {
    return this.view.onEvent(cb);
  }

  onToolCall(handler: CodexToolCallHandler): Unsubscribe {
    return this.view.onToolCall(handler);
  }

  onApprovalRequest(handler: CodexApprovalHandler): Unsubscribe {
    return this.view.onApprovalRequest(handler);
  }

  async startThread(opts: AgentStartThreadOptions = {}): Promise<StartThreadResult> {
    return this.view.startThread(opts);
  }

  async startThreadNative(opts: CodexStartThreadOptions = {}): Promise<StartThreadResult> {
    return this.view.startThreadNative(opts);
  }

  async forkThread(opts: AgentForkThreadOptions): Promise<AgentBackendStartThreadResult> {
    return this.view.forkThread(opts);
  }

  async resumeThread(threadId: string): Promise<void> {
    return this.view.resumeThread(threadId);
  }

  async clearThreadGitInfo(threadId: string): Promise<void> {
    return this.view.clearThreadGitInfo(threadId);
  }

  async startTurn(opts: AgentStartTurnOptions): Promise<{ turnId: string }> {
    return this.view.startTurn(opts);
  }

  async startTurnNative(opts: CodexStartTurnOptions): Promise<{ turnId: string }> {
    return this.view.startTurnNative(opts);
  }

  async interruptTurn(threadId: string): Promise<void> {
    return this.view.interruptTurn(threadId);
  }

  async archiveThread(threadId: string): Promise<void> {
    return this.view.archiveThread(threadId);
  }

  /** Tear down the owned Codex process (a `CodexThreadClient` owns its own). */
  async close(): Promise<void> {
    await this.owner.close();
  }
}
