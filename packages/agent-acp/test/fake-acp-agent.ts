// In-memory fake ACP transport for client/backend tests. Adapted from PwrAgnt
// testing/fake-acp-agent.ts to the agent-kit AcpJsonRpcTransport surface.

import type { JsonRpcId } from "@pwrdrvr/agent-transport";
import type { AcpJsonRpcTransport } from "../src/acp-transport";

export class FakeAcpAgentTransport implements AcpJsonRpcTransport {
  readonly requests: Array<{
    method: string;
    params?: Record<string, unknown>;
    timeoutMs?: number;
  }> = [];
  readonly notifications: Array<{ method: string; params?: Record<string, unknown> }> = [];
  closeCount = 0;

  private listeners = new Set<(method: string, params: Record<string, unknown>) => void>();
  private requestHandler:
    | ((
        method: string,
        params: Record<string, unknown>,
        id?: JsonRpcId
      ) => Promise<unknown> | unknown)
    | undefined;
  private nextSessionId = "session-1";

  /** Resolve/reject controls for the in-flight session/prompt, for cancel tests. */
  private pendingPrompt:
    | { resolve: (value: unknown) => void; reject: (error: Error) => void }
    | undefined;

  constructor(private readonly responses: Partial<Record<string, unknown>> = {}) {}

  async request(
    method: string,
    params?: Record<string, unknown>,
    timeoutMs?: number
  ): Promise<unknown> {
    this.requests.push({
      method,
      ...(params !== undefined ? { params } : {}),
      ...(timeoutMs !== undefined ? { timeoutMs } : {})
    });
    if (method in this.responses) {
      const canned = this.responses[method];
      // An Error response means "this RPC rejects" — lets tests simulate e.g.
      // an agent refusing `session/set_model` for an unknown model id.
      if (canned instanceof Error) throw canned;
      return canned;
    }
    if (method === "initialize") {
      return { protocolVersion: 1 };
    }
    if (method === "session/new") {
      return { sessionId: this.nextSessionId };
    }
    if (method === "session/prompt") {
      // Stay pending until the test resolves it (via finishPrompt) or cancels.
      return await new Promise((resolve, reject) => {
        this.pendingPrompt = { resolve, reject };
      });
    }
    return {};
  }

  async notify(method: string, params?: Record<string, unknown>): Promise<void> {
    this.notifications.push({ method, ...(params !== undefined ? { params } : {}) });
    if (method === "session/cancel" && this.pendingPrompt) {
      // A cancel terminates the in-flight prompt (ACP resolves the prompt RPC
      // with stopReason "cancelled").
      this.pendingPrompt.resolve({ stopReason: "cancelled" });
      this.pendingPrompt = undefined;
    }
  }

  onNotification(
    listener: (method: string, params: Record<string, unknown>) => void
  ): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  onRequest(
    listener: (
      method: string,
      params: Record<string, unknown>,
      id?: JsonRpcId
    ) => Promise<unknown> | unknown
  ): () => void {
    this.requestHandler = listener;
    return () => {
      if (this.requestHandler === listener) {
        this.requestHandler = undefined;
      }
    };
  }

  async close(): Promise<void> {
    this.closeCount += 1;
  }

  /** Resolve the in-flight session/prompt, completing the turn. */
  finishPrompt(result: unknown = { stopReason: "end_turn" }): void {
    this.pendingPrompt?.resolve(result);
    this.pendingPrompt = undefined;
  }

  /** Reject the in-flight session/prompt, failing the turn. */
  failPrompt(error: Error = new Error("session/prompt failed")): void {
    this.pendingPrompt?.reject(error);
    this.pendingPrompt = undefined;
  }

  hasPendingPrompt(): boolean {
    return this.pendingPrompt !== undefined;
  }

  emitSessionUpdate(sessionId: string, update: Record<string, unknown>): void {
    for (const listener of this.listeners) {
      listener("session/update", { sessionId, update });
    }
  }

  emitVendorNotification(params: {
    method: string;
    sessionId: string;
    update: Record<string, unknown>;
  }): void {
    for (const listener of this.listeners) {
      listener(params.method, { sessionId: params.sessionId, update: params.update });
    }
  }

  async emitRequest(
    method: string,
    params: Record<string, unknown>,
    id?: JsonRpcId
  ): Promise<unknown> {
    if (!this.requestHandler) {
      throw new Error("No ACP request handler registered");
    }
    return await this.requestHandler(method, params, id);
  }
}
