// JSON-RPC 2.0 client + server: pending-request tracking, notifications, inbound
// server-requests, and an optional message observer for protocol capture.
// Ported near-verbatim from PwrSnap/PwrAgnt; the only change is the logger is
// injected (agent-core `Logger`) instead of a module-global.

import { type Logger, noopLogger } from "@pwrdrvr/agent-core";

export type JsonRpcId = string | number;

type JsonRpcEnvelope = {
  jsonrpc?: string;
  id?: JsonRpcId | null;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: {
    code?: number;
    message?: string;
    data?: unknown;
  };
};

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

export type JsonRpcNotificationHandler = (method: string, params: unknown) => Promise<void> | void;

export type JsonRpcRequestHandler = (
  method: string,
  params: unknown,
  id?: JsonRpcId
) => Promise<unknown>;

export interface JsonRpcTransport {
  connect(): Promise<void>;
  close(): Promise<void>;
  send(message: string): void;
  setMessageHandler(handler: (message: string) => void): void;
  setCloseHandler(handler: (error?: Error) => void): void;
}

export type JsonRpcObserverEvent = {
  direction: "inbound" | "outbound";
  raw: string;
  envelope: JsonRpcEnvelope;
  diagnostics?: JsonRpcObserverDiagnostics | undefined;
};

export type JsonRpcObserverDiagnostics = {
  callerReason?: string | undefined;
  ownerId?: string | undefined;
};

export interface JsonRpcObserver {
  onMessage(event: JsonRpcObserverEvent): void | Promise<void>;
}

export type JsonRpcConnectionOptions = {
  logger?: Logger;
  logContext?: Record<string, string>;
};

function parseJsonRpcEnvelope(raw: string): JsonRpcEnvelope | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return null;
    }
    return parsed as JsonRpcEnvelope;
  } catch {
    return null;
  }
}

export class JsonRpcConnection {
  private readonly pending = new Map<string, PendingRequest>();
  private requestCounter = 0;
  private notificationHandler: JsonRpcNotificationHandler = () => undefined;
  private requestHandler: JsonRpcRequestHandler = async () => ({});
  private connected = false;
  // A transport can already be live when passed to the connection.
  private generation: symbol | null = Symbol();
  private readonly logger: Logger;

  constructor(
    private readonly transport: JsonRpcTransport,
    private readonly requestTimeoutMs: number,
    private readonly observer?: JsonRpcObserver,
    private readonly options: JsonRpcConnectionOptions = {}
  ) {
    this.logger = options.logger ?? noopLogger;
    this.transport.setMessageHandler((message) => {
      void this.handleMessage(message).catch((error: unknown) => {
        this.logger.error("json-rpc inbound handling failed", {
          ...this.options.logContext,
          error: error instanceof Error ? error.message : String(error)
        });
      });
    });
    this.transport.setCloseHandler((error) => {
      this.disconnect(error ?? new Error("json-rpc transport closed"));
    });
  }

  async connect(): Promise<void> {
    if (this.connected) {
      return;
    }
    const generation = (this.generation ??= Symbol());
    await this.transport.connect();
    if (this.generation === generation) this.connected = true;
  }

  async close(): Promise<void> {
    this.disconnect(new Error("json-rpc transport closed"));
    await this.transport.close();
  }

  setNotificationHandler(handler: JsonRpcNotificationHandler): void {
    this.notificationHandler = handler;
  }

  setRequestHandler(handler: JsonRpcRequestHandler): void {
    this.requestHandler = handler;
  }

  async notify(method: string, params?: unknown): Promise<void> {
    await this.sendEnvelope({
      jsonrpc: "2.0",
      method,
      params: params ?? {}
    });
  }

  request(
    method: string,
    params?: unknown,
    timeoutMs?: number,
    diagnostics?: JsonRpcObserverDiagnostics
  ): Promise<unknown> {
    const id = `rpc-${++this.requestCounter}`;
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`json-rpc timeout: ${method}`));
      }, Math.max(100, timeoutMs ?? this.requestTimeoutMs));
      this.pending.set(id, { resolve, reject, timer });

      // The reply, timeout or disconnect can settle the request while an
      // outbound observer is still running.
      void this.sendEnvelope(
        {
          jsonrpc: "2.0",
          id,
          method,
          params: params ?? {}
        },
        { diagnostics, canSend: () => this.pending.has(id) }
      ).catch((error: unknown) => {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      });
    });
  }

  private async handleMessage(rawMessage: string): Promise<void> {
    const generation = this.generation;
    if (generation === null) return;

    const envelope = parseJsonRpcEnvelope(rawMessage);
    if (!envelope) {
      // Never log raw protocol content: it can contain private data.
      this.logger.warn("json-rpc invalid inbound message", {
        ...this.options.logContext,
        length: rawMessage.length
      });
      return;
    }

    await this.notifyObserver({
      direction: "inbound",
      raw: rawMessage,
      envelope
    });
    const isCurrent = () => this.generation === generation;
    // Already-read notifications can still be delivered after EOF. Messages
    // with an ID belong to the connection that can settle or send their reply.
    if (envelope.id != null && !isCurrent()) return;

    if (
      envelope.id != null &&
      (Object.hasOwn(envelope, "result") || Object.hasOwn(envelope, "error"))
    ) {
      const key = String(envelope.id);
      const pending = this.pending.get(key);
      if (!pending) {
        return;
      }
      clearTimeout(pending.timer);
      this.pending.delete(key);

      if (envelope.error) {
        pending.reject(new Error(formatJsonRpcError(envelope.error)));
        return;
      }

      pending.resolve(envelope.result);
      return;
    }

    const method = envelope.method?.trim();
    if (!method) {
      return;
    }

    if (envelope.id == null) {
      await this.notificationHandler(method, envelope.params);
      return;
    }

    try {
      const result = await this.requestHandler(method, envelope.params, envelope.id);
      await this.sendEnvelope({
        jsonrpc: "2.0",
        id: envelope.id,
        result: result ?? {}
      }, { canSend: isCurrent });
    } catch (error) {
      await this.sendEnvelope({
        jsonrpc: "2.0",
        id: envelope.id,
        error: {
          code: -32603,
          message: error instanceof Error ? error.message : String(error)
        }
      }, { canSend: isCurrent });
    }
  }

  private async sendEnvelope(
    envelope: JsonRpcEnvelope,
    { diagnostics, canSend }: {
      diagnostics?: JsonRpcObserverDiagnostics | undefined;
      canSend?: () => boolean;
    } = {}
  ): Promise<void> {
    if (canSend && !canSend()) return;

    const raw = JSON.stringify(envelope);
    await this.notifyObserver({
      direction: "outbound",
      raw,
      envelope,
      diagnostics
    });
    if (!canSend || canSend()) this.transport.send(raw);
  }

  private async notifyObserver(event: JsonRpcObserverEvent): Promise<void> {
    if (!this.observer) {
      return;
    }

    try {
      await this.observer.onMessage(event);
    } catch (error) {
      this.logger.error("json-rpc observer failed", {
        ...this.options.logContext,
        direction: event.direction,
        message: event.envelope.method ?? event.envelope.id ?? "message",
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  private disconnect(error: Error): void {
    this.connected = false;
    this.generation = null;
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(error);
      this.pending.delete(id);
    }
  }
}

/** Render a JSON-RPC error envelope for a rejection message, INCLUDING its
 *  `data` payload when present (Codex/ACP carry structured detail there — often
 *  the nested provider error). Without this, error logs/UI lose the most useful
 *  part of the message. */
function formatJsonRpcError(error: NonNullable<JsonRpcEnvelope["error"]>): string {
  const base = `json-rpc error (${error.code ?? "unknown"}): ${
    error.message ?? "unknown error"
  }`;
  if (error.data === undefined) {
    return base;
  }
  return `${base}: ${formatJsonRpcErrorData(error.data)}`;
}

/** Serialize an error `data` payload for a message, truncated to ~1000 chars so
 *  a huge payload can't blow up a log line. Strings pass through; bigints
 *  stringify (JSON.stringify throws on them otherwise). */
function formatJsonRpcErrorData(data: unknown): string {
  const serialized =
    typeof data === "string"
      ? data
      : JSON.stringify(data, (_key, value) =>
          typeof value === "bigint" ? value.toString() : value
        );
  if (!serialized) {
    return String(data);
  }
  return serialized.length > 1_000 ? `${serialized.slice(0, 997)}...` : serialized;
}
