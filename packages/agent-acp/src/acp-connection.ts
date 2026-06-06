// ACP connection backed by the official `@zed-industries/agent-client-protocol`
// library. Replaces our hand-rolled ACP wire layer (acp-stdio-transport.ts): the
// library owns JSON-RPC framing, ndjson stdio, protocol-method dispatch, and
// schema validation. We keep ownership of the things the library does NOT do —
// spawning + process lifetime, discovery, the normalizer, and per-agent quirks.
//
// This implements the SAME `AcpJsonRpcTransport` seam the ACP clients already
// drive (request / notify / onNotification / onRequest), so `AcpAgentClient`,
// `AcpOneShotClient`, and the pool are unchanged — only the concrete connection
// they're handed swaps. The generic `request(method, params)` calls map onto the
// library's typed methods (with `extMethod` for non-standard ones like
// `session/set_config_option`); the library's `Client` callbacks
// (`sessionUpdate` / `extNotification` / `requestPermission`) bridge back out.

import { spawn } from "node:child_process";
import { Readable, Writable } from "node:stream";
import {
  ClientSideConnection,
  ndJsonStream,
  type Agent,
  type Client,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type SessionNotification
} from "@zed-industries/agent-client-protocol";
import { noopLogger, type Logger } from "@pwrdrvr/agent-core";
import type { JsonRpcId } from "@pwrdrvr/agent-transport";
import type { AcpJsonRpcTransport } from "./acp-transport";

/** The subset of the library's client→agent surface that `AcpConnection`
 *  drives. Injectable (via `createConnection`) so the adapter can be unit-tested
 *  without spawning a real agent. The library's `ClientSideConnection` satisfies
 *  this structurally (its methods take typed schema params; we pass records that
 *  match at runtime). */
export interface AcpAgentConnection {
  initialize(params: Record<string, unknown>): Promise<unknown>;
  newSession(params: Record<string, unknown>): Promise<unknown>;
  loadSession(params: Record<string, unknown>): Promise<unknown>;
  prompt(params: Record<string, unknown>): Promise<unknown>;
  cancel(params: Record<string, unknown>): Promise<void>;
  setSessionMode(params: Record<string, unknown>): Promise<unknown>;
  setSessionModel(params: Record<string, unknown>): Promise<unknown>;
  authenticate(params: Record<string, unknown>): Promise<unknown>;
  extMethod(method: string, params: Record<string, unknown>): Promise<Record<string, unknown>>;
  extNotification(method: string, params: Record<string, unknown>): Promise<void>;
}

/** Built connection + a teardown handle (kills the child / closes streams). */
export type AcpAgentConnectionHandle = {
  connection: AcpAgentConnection;
  dispose: () => void;
};

export type AcpConnectionOptions = {
  command: string;
  args: string[];
  env?: NodeJS.ProcessEnv;
  logger?: Logger;
  /** Test seam: build the underlying connection. Defaults to spawning the agent
   *  and wiring its stdio through the library's `ClientSideConnection`. */
  createConnection?: (client: Client) => AcpAgentConnectionHandle;
};

export class AcpConnection implements AcpJsonRpcTransport {
  private readonly logger: Logger;
  private connection: AcpAgentConnection | undefined;
  private dispose: (() => void) | undefined;
  private connecting: Promise<void> | undefined;
  private readonly notificationListeners = new Set<
    (method: string, params: Record<string, unknown>) => void
  >();
  private requestHandler:
    | ((method: string, params: Record<string, unknown>, id?: JsonRpcId) => Promise<unknown> | unknown)
    | undefined;

  constructor(private readonly options: AcpConnectionOptions) {
    this.logger = options.logger ?? noopLogger;
  }

  /** The `Client` handler the library invokes for agent→client traffic. */
  private buildClient(): Client {
    const emit = (method: string, params: Record<string, unknown>): void => {
      for (const listener of this.notificationListeners) listener(method, params);
    };
    return {
      requestPermission: async (
        params: RequestPermissionRequest
      ): Promise<RequestPermissionResponse> => {
        if (!this.requestHandler) {
          throw new Error("ACP request handler unavailable for session/request_permission");
        }
        return (await this.requestHandler(
          "session/request_permission",
          params as unknown as Record<string, unknown>
        )) as RequestPermissionResponse;
      },
      sessionUpdate: async (params: SessionNotification): Promise<void> => {
        // Emit the full notification ({ sessionId, update }); the client extracts
        // `update` and feeds the normalizer — same shape the old transport gave.
        emit("session/update", params as unknown as Record<string, unknown>);
      },
      extNotification: async (method: string, params: Record<string, unknown>): Promise<void> => {
        // Vendor notifications (e.g. Grok's session_summary_generated) — routed to
        // the client's `vendorNotificationMethods` handling.
        emit(method, params);
      },
      extMethod: async (
        method: string,
        params: Record<string, unknown>
      ): Promise<Record<string, unknown>> => {
        if (!this.requestHandler) {
          throw new Error(`ACP request handler unavailable for ${method}`);
        }
        return ((await this.requestHandler(method, params)) ?? {}) as Record<string, unknown>;
      }
      // No fs/terminal handlers: we don't advertise those client capabilities at
      // `initialize`, so a conformant agent won't call them.
    };
  }

  private async ensureConnected(): Promise<void> {
    if (this.connection) return;
    this.connecting ??= this.connect();
    await this.connecting;
  }

  private async connect(): Promise<void> {
    const create = this.options.createConnection ?? this.defaultCreateConnection();
    const handle = create(this.buildClient());
    this.connection = handle.connection;
    this.dispose = handle.dispose;
  }

  private defaultCreateConnection(): (client: Client) => AcpAgentConnectionHandle {
    const { command, args, env } = this.options;
    const logger = this.logger;
    return (client) => {
      const child = spawn(command, args, {
        stdio: ["pipe", "pipe", "pipe"],
        ...(env !== undefined ? { env } : {})
      });
      child.on("error", (error: Error) => {
        logger.error("acp agent process error", { command, message: error.message });
      });
      child.stderr?.on("data", (chunk: Buffer) => {
        const line = chunk.toString("utf8").trimEnd();
        if (line.length > 0) logger.debug("acp agent stderr", { line });
      });
      // ndJsonStream(writeToAgentStdin, readFromAgentStdout) — arg order: first is
      // the WritableStream we send to, second is the ReadableStream we read from.
      const toAgentStdin = Writable.toWeb(child.stdin) as WritableStream<Uint8Array>;
      const fromAgentStdout = Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>;
      const stream = ndJsonStream(toAgentStdin, fromAgentStdout);
      const connection = new ClientSideConnection(
        (_agent: Agent) => client,
        stream
      ) as unknown as AcpAgentConnection;
      return {
        connection,
        dispose: () => {
          try {
            child.stdin?.end();
          } catch {
            // already closed
          }
          child.kill();
        }
      };
    };
  }

  async request(
    method: string,
    params: Record<string, unknown> = {},
    _timeoutMs?: number
  ): Promise<unknown> {
    await this.ensureConnected();
    const conn = this.connection;
    if (!conn) throw new Error("acp connection unavailable");
    switch (method) {
      case "initialize":
        return await conn.initialize(params);
      case "session/new":
        return await conn.newSession(params);
      case "session/load":
        return await conn.loadSession(params);
      case "session/prompt":
        return await conn.prompt(params);
      case "session/set_mode":
        return await conn.setSessionMode(params);
      case "session/set_model":
        return await conn.setSessionModel(params);
      case "session/cancel":
        await conn.cancel(params);
        return {};
      case "authenticate":
        return await conn.authenticate(params);
      default:
        // Non-standard method (e.g. session/set_config_option) → ACP extension.
        return await conn.extMethod(method, params);
    }
  }

  async notify(method: string, params: Record<string, unknown> = {}): Promise<void> {
    await this.ensureConnected();
    const conn = this.connection;
    if (!conn) throw new Error("acp connection unavailable");
    if (method === "session/cancel") {
      await conn.cancel(params);
      return;
    }
    await conn.extNotification(method, params);
  }

  async close(): Promise<void> {
    try {
      this.dispose?.();
    } finally {
      this.connection = undefined;
      this.dispose = undefined;
      this.connecting = undefined;
    }
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
