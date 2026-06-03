// ACP stdio transport. Wraps @pwrdrvr/agent-transport's JsonRpcConnection +
// StdioJsonRpcTransport — we do NOT reimplement JSON-RPC or the line-delimited
// stdio framing. This adapter just spawns the agent's ACP stdio command and
// presents the bidirectional ACP shape (request / notify / onNotification /
// onRequest) the AcpAgentClient consumes.
//
// Ported from PwrAgnt acp-stdio-transport.ts, retargeted onto the shared core.

import { noopLogger, type Logger } from "@pwrdrvr/agent-core";
import {
  JsonRpcConnection,
  StdioJsonRpcTransport,
  type JsonRpcId,
  type JsonRpcObserver,
  type JsonRpcTransport
} from "@pwrdrvr/agent-transport";

const DEFAULT_REQUEST_TIMEOUT_MS = 10 * 60_000;

/** The bidirectional transport shape the ACP client drives. */
export interface AcpJsonRpcTransport {
  request(
    method: string,
    params?: Record<string, unknown>,
    timeoutMs?: number
  ): Promise<unknown>;
  notify?(method: string, params?: Record<string, unknown>): Promise<void>;
  close?(): Promise<void>;
  onNotification(
    listener: (method: string, params: Record<string, unknown>) => void
  ): () => void;
  onRequest?(
    listener: (
      method: string,
      params: Record<string, unknown>,
      id?: JsonRpcId
    ) => Promise<unknown> | unknown
  ): () => void;
}

export type AcpStdioJsonRpcTransportOptions = {
  command: string;
  args: string[];
  env?: NodeJS.ProcessEnv;
  requestTimeoutMs?: number;
  observer?: JsonRpcObserver;
  logger?: Logger;
  /** Override the underlying JSON-RPC transport (tests inject a fake). */
  transport?: JsonRpcTransport;
};

export class AcpStdioJsonRpcTransport implements AcpJsonRpcTransport {
  private readonly connection: JsonRpcConnection;
  private readonly notificationListeners = new Set<
    (method: string, params: Record<string, unknown>) => void
  >();
  private requestHandler:
    | ((
        method: string,
        params: Record<string, unknown>,
        id?: JsonRpcId
      ) => Promise<unknown> | unknown)
    | undefined;

  constructor(options: AcpStdioJsonRpcTransportOptions) {
    const logger = options.logger ?? noopLogger;
    const transport =
      options.transport ??
      new StdioJsonRpcTransport({
        command: options.command,
        args: options.args,
        ...(options.env !== undefined ? { env: options.env } : {}),
        logger
      });
    this.connection = new JsonRpcConnection(
      transport,
      options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
      options.observer,
      { logger, logContext: { owner: "acp-stdio-transport" } }
    );
    this.connection.setNotificationHandler((method, params) => {
      const normalized = asRecord(params) ?? {};
      for (const listener of this.notificationListeners) {
        listener(method, normalized);
      }
    });
    this.connection.setRequestHandler(async (method, params, id) => {
      if (!this.requestHandler) {
        throw new Error(`ACP request handler unavailable for ${method}`);
      }
      return await this.requestHandler(method, asRecord(params) ?? {}, id);
    });
  }

  async connect(): Promise<void> {
    await this.connection.connect();
  }

  async request(
    method: string,
    params?: Record<string, unknown>,
    timeoutMs?: number
  ): Promise<unknown> {
    await this.connection.connect();
    return await this.connection.request(method, params, timeoutMs);
  }

  async notify(method: string, params?: Record<string, unknown>): Promise<void> {
    await this.connection.connect();
    await this.connection.notify(method, params);
  }

  async close(): Promise<void> {
    await this.connection.close();
  }

  onNotification(
    listener: (method: string, params: Record<string, unknown>) => void
  ): () => void {
    this.notificationListeners.add(listener);
    return () => {
      this.notificationListeners.delete(listener);
    };
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
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
