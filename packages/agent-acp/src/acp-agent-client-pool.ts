// Lifecycle pool for `AcpAgentClient`. An ACP agent is a long-lived OS process
// with a stdio connection, and ONE client can host many concurrent sessions
// (threads). Without pooling, every consumer (each chat surface, enrichment,
// the model-lister) news up its own client → its own process; a careless React
// caller can spawn dozens. The pool gives every caller the SAME warmed client
// for a key, dedups concurrent warm-ups onto one spawn, and owns teardown.
//
//   const pool = new AcpAgentClientPool();
//   pool.warm("gemini@/opt/homebrew/bin/gemini", () => new AcpAgentClient(...)); // startup
//   const client = await pool.acquire(key, factory); // surfaces — same instance

import { noopLogger, type Logger } from "@pwrdrvr/agent-core";
import type { AcpAgentClient } from "./acp-client";

export type AcpAgentClientFactory = () => AcpAgentClient;

export type AcpAgentClientPoolOptions = {
  /** Max time to wait for a client to warm (spawn + `initialize`) before an
   *  `acquire` rejects. Default 30s. */
  warmTimeoutMs?: number;
  logger?: Logger;
};

type PoolEntry = {
  client: AcpAgentClient;
  /** Resolves to the client once warmed; shared by concurrent acquires. */
  ready: Promise<AcpAgentClient>;
};

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

export class AcpAgentClientPool {
  private readonly entries = new Map<string, PoolEntry>();
  private readonly warmTimeoutMs: number;
  private readonly logger: Logger;

  constructor(options: AcpAgentClientPoolOptions = {}) {
    this.warmTimeoutMs = options.warmTimeoutMs ?? 30_000;
    this.logger = options.logger ?? noopLogger;
  }

  /**
   * Return the shared, warmed client for `key`, creating it via `factory` if it
   * doesn't exist. Concurrent acquires for the same key share ONE spawn — they
   * receive the same in-flight promise, which resolves when the agent is ready
   * or rejects if warm-up fails / times out. A failed warm-up evicts the entry
   * so a later acquire retries with a fresh client.
   */
  async acquire(key: string, factory: AcpAgentClientFactory): Promise<AcpAgentClient> {
    const existing = this.entries.get(key);
    if (existing !== undefined) return existing.ready;
    const client = factory();
    const ready = this.warmWithTimeout(key, client);
    this.entries.set(key, { client, ready });
    return ready;
  }

  /** Fire-and-forget warm-up for app startup. Errors are logged, not thrown. */
  warm(key: string, factory: AcpAgentClientFactory): void {
    void this.acquire(key, factory).catch((cause) => {
      this.logger.warn?.("acp pool: background warm-up failed", {
        key,
        message: errorMessage(cause)
      });
    });
  }

  /** Whether a (warming or warm) entry exists for `key`. */
  has(key: string): boolean {
    return this.entries.has(key);
  }

  /** Close + evict ONE key (e.g. its config changed). Safe if absent. */
  async release(key: string): Promise<void> {
    const entry = this.entries.get(key);
    if (entry === undefined) return;
    this.entries.delete(key);
    // Don't let a still-warming entry surface an unhandled rejection on release.
    entry.ready.catch(() => undefined);
    await entry.client.close().catch(() => undefined);
  }

  /** Close + evict EVERY entry (app quit). */
  async closeAll(): Promise<void> {
    const entries = [...this.entries.values()];
    this.entries.clear();
    for (const entry of entries) entry.ready.catch(() => undefined);
    await Promise.allSettled(entries.map((entry) => entry.client.close()));
  }

  private async warmWithTimeout(
    key: string,
    client: AcpAgentClient
  ): Promise<AcpAgentClient> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        client.connect(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () =>
              reject(
                new Error(`ACP agent "${key}" warm-up timed out after ${this.warmTimeoutMs}ms`)
              ),
            this.warmTimeoutMs
          );
        })
      ]);
      return client;
    } catch (cause) {
      // Evict so a later acquire retries with a fresh client, and tear down the
      // half-spawned process.
      if (this.entries.get(key)?.client === client) this.entries.delete(key);
      await client.close().catch(() => undefined);
      throw cause;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }
}
