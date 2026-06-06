// One-shot structured turn against an ACP agent — the ACP analog of the Codex
// `CodexOneShotClient`. Used for non-interactive jobs (e.g. capture
// enrichment): one prompt + optional images in, one assistant message out, no
// chat, no tools, no approvals.
//
// Lifecycle parity with the Codex one-shot:
//   • The agent PROCESS is persistent — the transport connects lazily on the
//     first request and stays connected across `run()` calls; `close()` tears
//     it down.
//   • Each `run()` opens a FRESH ACP session (`session/new`) so per-call
//     context is clean. ACP has no `thread/rollback`, so a new session is the
//     equivalent of Codex's per-turn rollback.
//
// Differences from Codex, by protocol:
//   • No `outputSchema` — ACP can't constrain the reply, so the CALLER must
//     bake the "reply with JSON only" contract into the prompt and parse +
//     validate the returned text.
//   • No base-instructions on `session/new` — the caller folds any system
//     preamble into the prompt text too.
//
// Enrichment is non-interactive: approvals are auto-denied and tool calls are
// rejected, so the agent can only answer.

import {
  noopLogger,
  type Logger,
  type NormalizedThreadEvent,
  type NormalizedTokenUsage
} from "@pwrdrvr/agent-core";
import { AcpAgentClient } from "./acp-client";
import type { AcpJsonRpcTransport } from "./acp-transport";
import type { AcpAgentStrategy } from "./strategies/strategy-types";
import type { AcpRuntimeModel } from "./normalizer/runtime-capabilities";

export type AcpOneShotClientOptions = {
  /** Connected (or lazily-connecting) ACP stdio transport for the agent. */
  transport: AcpJsonRpcTransport;
  /** Strategy carrying the agent's spawn + normalization quirks. */
  strategy: AcpAgentStrategy;
  clientName?: string;
  clientTitle?: string;
  clientVersion?: string;
  /** Scratch cwd for the session (keep enrichment out of any repo). */
  cwd?: string;
  logger?: Logger;
  now?: () => number;
};

export type AcpOneShotRequest = {
  /** Full prompt text — the caller folds in any system preamble + the
   *  "reply with ONLY JSON matching <schema>" contract. */
  prompt: string;
  /** Local image file paths attached to the turn (ACP image content blocks). */
  imagePaths?: readonly string[];
  /** Model id to select for the session. Omit for the agent default. */
  model?: string | null;
  /** Reasoning effort token (agent-specific). */
  effort?: string;
  abortSignal?: AbortSignal;
};

export type AcpOneShotResponse = {
  /** The agent's final assistant-message text. Caller parses + validates it. */
  rawText: string;
  threadId: string;
  turnId: string;
  model: string;
  modelProvider: string;
  serviceTier: string | null;
  tokenUsage: NormalizedTokenUsage | null;
};

export class AcpOneShotClient {
  private readonly client: AcpAgentClient;
  private readonly strategy: AcpAgentStrategy;
  private readonly denyApprovals: () => void;
  private readonly rejectTools: () => void;
  /** Serialize runs — one turn at a time against the agent. */
  private queue: Promise<void> = Promise.resolve();

  constructor(options: AcpOneShotClientOptions) {
    this.strategy = options.strategy;
    const logger = options.logger ?? noopLogger;
    this.client = new AcpAgentClient({
      transport: options.transport,
      strategy: options.strategy,
      ...(options.clientName !== undefined ? { clientName: options.clientName } : {}),
      ...(options.clientTitle !== undefined ? { clientTitle: options.clientTitle } : {}),
      ...(options.clientVersion !== undefined ? { clientVersion: options.clientVersion } : {}),
      ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
      ...(options.now !== undefined ? { now: options.now } : {}),
      logger
    });
    // Non-interactive: never approve, never run tools.
    this.denyApprovals = this.client.onApprovalRequest(async () => "denied");
    this.rejectTools = this.client.onToolCall(async () => {
      throw new Error("ACP one-shot does not support tool calls");
    });
  }

  /** Run one structured turn. Serialized — one in-flight at a time. */
  async run(request: AcpOneShotRequest): Promise<AcpOneShotResponse> {
    const run = this.queue.catch(() => undefined).then(() => this.runInner(request));
    this.queue = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }

  private async runInner(request: AcpOneShotRequest): Promise<AcpOneShotResponse> {
    if (request.abortSignal?.aborted === true) {
      throw new Error("ACP one-shot aborted before start");
    }
    // Fresh session per call → clean per-capture context.
    const thread = await this.client.startThread(
      request.model !== undefined && request.model !== null ? { model: request.model } : {}
    );

    let finalText = "";
    const deltas: string[] = [];
    let usage: NormalizedTokenUsage | null = null;
    let turnError: string | null = null;
    // `startTurn` now resolves at turn START (it streams terminal events
    // asynchronously), so we gate completion on the `turn_completed` event for
    // this thread rather than on `startTurn` resolving.
    let settle: (status: string) => void = () => undefined;
    const done = new Promise<string>((resolve) => {
      settle = resolve;
    });
    const unsubscribe = this.client.onEvent((event: NormalizedThreadEvent) => {
      if (!("threadId" in event) || event.threadId !== thread.threadId) return;
      if (event.kind === "agent_message") finalText = event.message.text;
      else if (event.kind === "agent_message_delta") deltas.push(event.delta);
      else if (event.kind === "token_usage") usage = event.usage;
      else if (event.kind === "error") turnError = event.message;
      else if (event.kind === "turn_completed") settle(event.status);
    });

    try {
      const { turnId } = await this.client.startTurn({
        threadId: thread.threadId,
        input: {
          text: request.prompt,
          ...(request.imagePaths !== undefined && request.imagePaths.length > 0
            ? { imagePaths: request.imagePaths }
            : {})
        },
        ...(request.effort !== undefined ? { reasoning: request.effort } : {})
      });
      const status = await done;
      if (status !== "completed") {
        throw new Error(turnError ?? `ACP one-shot turn ${status}`);
      }
      const rawText = finalText.length > 0 ? finalText : deltas.join("");
      return {
        rawText,
        threadId: thread.threadId,
        turnId,
        model: request.model ?? thread.model ?? "",
        modelProvider: thread.modelProvider ?? this.strategy.backendId,
        serviceTier: thread.serviceTier ?? null,
        tokenUsage: usage
      };
    } finally {
      unsubscribe();
    }
  }

  /** Open a throwaway session and read the agent's advertised models (ACP
   *  agents report runtime capabilities — models/modes — on `session/new`).
   *  Returns [] when the agent advertises none. Serialized with `run()`. */
  async listModels(): Promise<AcpRuntimeModel[]> {
    const run = this.queue.catch(() => undefined).then(() => this.listModelsInner());
    this.queue = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }

  private async listModelsInner(): Promise<AcpRuntimeModel[]> {
    let models: AcpRuntimeModel[] = [];
    const unsubscribe = this.client.onRuntimeCapabilities((event) => {
      const observed = event.runtimeCapabilities.models?.availableModels;
      if (observed !== undefined && observed.length > 0) models = observed;
    });
    try {
      // `session/new` triggers the runtime-capabilities notification
      // synchronously, so `models` is populated by the time this resolves.
      await this.client.startThread();
      return models;
    } finally {
      unsubscribe();
    }
  }

  async close(): Promise<void> {
    this.denyApprovals();
    this.rejectTools();
    await this.client.close();
  }
}
