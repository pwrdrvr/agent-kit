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

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Coerce a tool-call notification's `rawInput` / `rawOutput` so it survives the
 *  library's schema, which types BOTH as `z.record(z.unknown())` (a plain
 *  object). Real agents don't honor that: Kimi sends `rawOutput` as a JSON
 *  STRING (a tool's text result) or an ARRAY, which fails validation and makes
 *  the library reject the WHOLE `session/update` (`-32602 Invalid params`,
 *  logged as "Error handling notification") — so the tool's status update is
 *  silently dropped. Our old hand-rolled connection never validated, so it
 *  tolerated this. We wrap a non-object value as `{ value: <orig> }` (data
 *  preserved, schema satisfied) and drop an explicit `null` (the field is
 *  `.optional()`, not nullable). Plain-object values pass through untouched, so
 *  the normal `rawInput` args object is unchanged. */
export function sanitizeAcpNotificationLine(line: string): string {
  if (line.trim().length === 0) return line;
  let message: unknown;
  try {
    message = JSON.parse(line);
  } catch {
    return line; // not JSON (or a partial line) — never our concern.
  }
  if (!isPlainObject(message) || message.method !== "session/update") return line;
  const params = message.params;
  if (!isPlainObject(params)) return line;
  const update = params.update;
  if (!isPlainObject(update)) return line;
  let changed = false;
  for (const key of ["rawInput", "rawOutput"] as const) {
    if (!(key in update)) continue;
    const value = update[key];
    if (value === undefined || isPlainObject(value)) continue;
    if (value === null) {
      delete update[key];
    } else {
      update[key] = { value };
    }
    changed = true;
  }
  return changed ? JSON.stringify(message) : line;
}

/** Wrap an agent's stdout so every inbound ndjson line is sanitized
 *  (`sanitizeAcpNotificationLine`) before the library frames + validates it. */
function sanitizeInboundStream(
  source: ReadableStream<Uint8Array>
): ReadableStream<Uint8Array> {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffer = "";
  return source.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        buffer += decoder.decode(chunk, { stream: true });
        let nl = buffer.indexOf("\n");
        while (nl !== -1) {
          const line = buffer.slice(0, nl);
          buffer = buffer.slice(nl + 1);
          controller.enqueue(encoder.encode(sanitizeAcpNotificationLine(line) + "\n"));
          nl = buffer.indexOf("\n");
        }
      },
      flush(controller) {
        if (buffer.length > 0) {
          controller.enqueue(encoder.encode(sanitizeAcpNotificationLine(buffer)));
          buffer = "";
        }
      }
    })
  );
}

/** Rewrite an OUTBOUND ndjson request line to fix the config-option method name.
 *
 *  ACP config options aren't a typed method in the underlying library, so the
 *  generic `request()` path routes `session/set_config_option` through the
 *  library's `extMethod`, which prefixes EVERY extension method with `_` (the
 *  spec's marker for non-standard methods) → `_session/set_config_option`.
 *  Agents that implement config options (e.g. Kimi) expose them WITHOUT the
 *  underscore and reject the prefixed name with "Method not found", so the
 *  thinking/thought-level toggle silently never applies. Strip the prefix for
 *  this one method on the way out. JSON-RPC correlates responses by `id`, so the
 *  rewritten method name doesn't affect the library's pending-request matching.
 *  Exported for testing. */
export function rewriteOutboundAcpLine(line: string): string {
  if (line.trim().length === 0) return line;
  let message: unknown;
  try {
    message = JSON.parse(line);
  } catch {
    return line; // not JSON (or a partial line) — never our concern.
  }
  if (!isPlainObject(message) || message.method !== "_session/set_config_option") {
    return line;
  }
  message.method = "session/set_config_option";
  return JSON.stringify(message);
}

/** Wrap an agent's stdin so every OUTBOUND ndjson line is passed through
 *  `rewriteOutboundAcpLine` before it reaches the agent. Returns the
 *  WritableStream the library writes to; rewritten bytes flow to `target`. */
function rewriteOutboundStream(
  target: WritableStream<Uint8Array>
): WritableStream<Uint8Array> {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffer = "";
  const transform = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      buffer += decoder.decode(chunk, { stream: true });
      let nl = buffer.indexOf("\n");
      while (nl !== -1) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        controller.enqueue(encoder.encode(rewriteOutboundAcpLine(line) + "\n"));
        nl = buffer.indexOf("\n");
      }
    },
    flush(controller) {
      if (buffer.length > 0) {
        controller.enqueue(encoder.encode(rewriteOutboundAcpLine(buffer)));
        buffer = "";
      }
    }
  });
  void transform.readable.pipeTo(target).catch(() => undefined);
  return transform.writable;
}

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
      // Rewrite outbound `_session/set_config_option` → `session/set_config_option`
      // (the library prefixes extension methods with `_`, which config-option
      // agents like Kimi reject). See `rewriteOutboundAcpLine`.
      const toAgentStdin = rewriteOutboundStream(
        Writable.toWeb(child.stdin) as WritableStream<Uint8Array>
      );
      // Sanitize inbound ndjson BEFORE the library frames + schema-validates it,
      // so a non-spec `rawInput`/`rawOutput` (e.g. Kimi's string/array tool
      // output) doesn't get the whole notification rejected. See
      // `sanitizeAcpNotificationLine`.
      const fromAgentStdout = sanitizeInboundStream(
        Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>
      );
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
