// Lifecycle pool for `CodexProcessOwner` — the Codex counterpart of
// `AcpAgentClientPool`. A Codex App Server is a long-lived OS process with a
// stdio connection, and ONE owner hosts many concurrent threads (one per chat
// surface, plus model-listing and enrichment one-shots over the same socket).
// Without pooling, every consumer (Library chat, Sizzle chat, capture
// enrichment, a model-picker refresh) news up its own client → its own process;
// a careless caller can spawn several Codex processes for what should be one.
// The pool gives every caller the SAME warmed owner for a key, dedups
// concurrent warm-ups onto one spawn, and owns teardown.
//
//   const pool = new CodexProcessOwnerPool();
//   // key on the connection identity the host varies — e.g. `(command, CODEX_HOME)`:
//   const key = `${command}::${codexHome ?? "default"}`;
//   pool.warm(key, () => new CodexProcessOwner({ command, env })); // startup
//   const owner = await pool.acquire(key, factory);                // surfaces — same instance
//   const view = owner.createBackendView();                        // per-surface backend

import { noopLogger, type Logger } from "@pwrdrvr/agent-core";
import type { CodexProcessOwner } from "./codex-process-owner";

export type CodexProcessOwnerFactory = () => CodexProcessOwner;

export type CodexProcessOwnerPoolOptions = {
  /** Max time to wait for an owner to warm (spawn + `initialize`) before an
   *  `acquire` rejects. Default 30s. */
  warmTimeoutMs?: number;
  logger?: Logger;
};

type PoolEntry = {
  owner: CodexProcessOwner;
  /** Resolves to the owner once warmed; shared by concurrent acquires. */
  ready: Promise<CodexProcessOwner>;
};

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

export class CodexProcessOwnerPool {
  private readonly entries = new Map<string, PoolEntry>();
  private readonly warmTimeoutMs: number;
  private readonly logger: Logger;

  constructor(options: CodexProcessOwnerPoolOptions = {}) {
    this.warmTimeoutMs = options.warmTimeoutMs ?? 30_000;
    this.logger = options.logger ?? noopLogger;
  }

  /**
   * Return the shared, warmed owner for `key`, creating it via `factory` if it
   * doesn't exist. Concurrent acquires for the same key share ONE spawn — they
   * receive the same in-flight promise, which resolves when Codex is ready or
   * rejects if warm-up fails / times out. A failed warm-up evicts the entry so a
   * later acquire retries with a fresh owner.
   */
  async acquire(key: string, factory: CodexProcessOwnerFactory): Promise<CodexProcessOwner> {
    const existing = this.entries.get(key);
    if (existing !== undefined) return existing.ready;
    const owner = factory();
    const ready = this.warmWithTimeout(key, owner);
    this.entries.set(key, { owner, ready });
    return ready;
  }

  /** Fire-and-forget warm-up for app startup. Errors are logged, not thrown. */
  warm(key: string, factory: CodexProcessOwnerFactory): void {
    void this.acquire(key, factory).catch((cause) => {
      this.logger.warn?.("codex pool: background warm-up failed", {
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
    await entry.owner.close().catch(() => undefined);
  }

  /** Close + evict EVERY entry (app quit). */
  async closeAll(): Promise<void> {
    const entries = [...this.entries.values()];
    this.entries.clear();
    for (const entry of entries) entry.ready.catch(() => undefined);
    await Promise.allSettled(entries.map((entry) => entry.owner.close()));
  }

  private async warmWithTimeout(
    key: string,
    owner: CodexProcessOwner
  ): Promise<CodexProcessOwner> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        owner.connect(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () =>
              reject(
                new Error(`Codex owner "${key}" warm-up timed out after ${this.warmTimeoutMs}ms`)
              ),
            this.warmTimeoutMs
          );
        })
      ]);
      return owner;
    } catch (cause) {
      // Evict so a later acquire retries with a fresh owner, and tear down the
      // half-spawned process.
      if (this.entries.get(key)?.owner === owner) this.entries.delete(key);
      await owner.close().catch(() => undefined);
      throw cause;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }
}
