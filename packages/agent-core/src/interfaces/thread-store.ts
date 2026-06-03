// The host injects persistence; the kit never imports better-sqlite3 or any
// concrete store. The canonical chat controller records usage and persists thread
// metadata + the per-turn message journal through these interfaces (PwrSnap's
// ChatThreadStore + saveAiThreadUsage become the concrete impl, behind this seam).
//
// The persistence surface mirrors PwrSnap's ChatThreadStore with neutral types:
// prepare/discard a thread dir, create/list/get/update/delete an index row,
// append an anchor-focus entry, append/read the per-turn journal, resolve the
// attachments dir, and record usage. The host implements all of this against its
// own DB + filesystem.

import type { NormalizedThread, NormalizedThreadSummary, ThreadId, TurnId } from "../schema/thread";
import type { NormalizedTokenUsage } from "../schema/usage";
import type {
  NormalizedThreadRecord,
  PreparedThreadDir,
  ThreadCreateOptions,
  ThreadListOptions,
  ThreadUpdatePatch
} from "../schema/thread-record";

export type NormalizedUsageRecord = {
  threadId: ThreadId;
  turnId: TurnId;
  model?: string;
  usage: NormalizedTokenUsage;
  /** The model's context window size, when the backend reported it. Mirrors
   *  `NormalizedTokenUsage.contextWindow`; surfaced here too so a store that
   *  persists a flat usage row doesn't have to dig into `usage`. */
  contextWindow?: number;
  /** Cost the host estimated for this turn, if it computes one. */
  estimatedCostUsd?: number;
  /** Epoch ms; the host may stamp it, else the store defaults. */
  at?: number;
};

/** Minimal sink for turn usage/cost accounting. */
export interface UsageSink {
  recordUsage(record: NormalizedUsageRecord): Promise<void>;
}

/**
 * Thread persistence + the usage sink. The canonical chat controller depends on
 * this. The host implements it against its own DB (index rows) + filesystem
 * (per-turn journal + attachments). All methods are async so a host can back
 * them with any store.
 */
export interface ThreadStore extends UsageSink {
  // ---- thread directory lifecycle ----

  /** Mint a thread workspace directory BEFORE the backend opens the thread, so
   *  the caller can pass `prepared.path` as the backend's cwd. */
  prepareThreadDir(name: string): Promise<PreparedThreadDir>;

  /** Best-effort cleanup for a prepared dir whose backend thread failed to
   *  start. Once a row exists, use `delete(threadId)` instead. */
  discardPreparedThreadDir(prepared: PreparedThreadDir): Promise<void>;

  // ---- thread index (metadata) ----

  /** Mint the index row for a freshly-opened thread (anchor written in the same
   *  write — one write, not create-then-update). */
  create(opts: ThreadCreateOptions): Promise<NormalizedThreadRecord>;

  /** List threads, newest-activity-first, filtered per `opts` in the store's
   *  indexed query (never a full scan in the controller). */
  list(opts?: ThreadListOptions): Promise<NormalizedThreadRecord[]>;

  /** The record for `threadId`, or null when absent. */
  get(threadId: ThreadId): Promise<NormalizedThreadRecord | null>;

  /** Patch the mutable metadata fields (`name` / `archived` / `pinned`) and bump
   *  `modifiedAt`. Throws for an unknown thread. */
  update(threadId: ThreadId, patch: ThreadUpdatePatch): Promise<NormalizedThreadRecord>;

  /** Hard-delete a thread: index row + on-disk dir (journal + attachments).
   *  No-op for an unknown thread. */
  delete(threadId: ThreadId): Promise<void>;

  /** Push an anchor-focus entry onto the thread's anchor history (capped by the
   *  store) and set the current `anchorId`. Bumps `modifiedAt`. */
  appendAnchor(threadId: ThreadId, anchorId: string): Promise<void>;

  // ---- per-turn journal + attachments ----

  /** Append one entry to the append-only per-turn journal. */
  journalAppend(threadId: ThreadId, entry: unknown): Promise<void>;

  /** Read every parseable journal entry, in order. `[]` for an unknown thread or
   *  a missing journal. A torn final entry (crash mid-append) is skipped. */
  readJournal(threadId: ThreadId): Promise<unknown[]>;

  /** The attachments dir path for a thread, created on demand. Throws for an
   *  unknown thread. */
  attachmentsDir(threadId: ThreadId): Promise<string>;

  // ---- materialized-transcript convenience (optional persisted view) ----
  //
  // Retained from the prior thin store so a host that prefers persisting a
  // materialized `NormalizedThread` (rather than reconstructing it from the
  // journal) can. The canonical controller drives the journal API; these stay
  // optional.

  saveThread?(thread: NormalizedThread): Promise<void>;
  loadThread?(id: ThreadId): Promise<NormalizedThread | null>;
  listThreadSummaries?(): Promise<NormalizedThreadSummary[]>;
}
