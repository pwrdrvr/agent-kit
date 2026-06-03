// The host injects persistence; the kit never imports better-sqlite3 or any
// concrete store. The chat controller records usage and persists threads through
// these interfaces (PwrSnap's ChatThreadStore + saveAiThreadUsage become the
// concrete impl, behind this seam).

import type { NormalizedThread, NormalizedThreadSummary, ThreadId, TurnId } from "../schema/thread";
import type { NormalizedTokenUsage } from "../schema/usage";

export type NormalizedUsageRecord = {
  threadId: ThreadId;
  turnId: TurnId;
  model?: string;
  usage: NormalizedTokenUsage;
  /** Cost the host estimated for this turn, if it computes one. */
  estimatedCostUsd?: number;
  /** Epoch ms; the host may stamp it, else the store defaults. */
  at?: number;
};

/** Minimal sink for turn usage/cost accounting. */
export interface UsageSink {
  recordUsage(record: NormalizedUsageRecord): Promise<void>;
}

/** Thread persistence + the usage sink. The chat controller depends on this. */
export interface ThreadStore extends UsageSink {
  saveThread(thread: NormalizedThread): Promise<void>;
  loadThread(id: ThreadId): Promise<NormalizedThread | null>;
  listThreads(): Promise<NormalizedThreadSummary[]>;
}
