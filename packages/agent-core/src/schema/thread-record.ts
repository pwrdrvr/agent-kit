// Neutral, backend-agnostic thread-metadata shapes for the canonical chat
// controller. Generalizes PwrSnap's Library-Chat thread vocabulary
// (LibraryChatThreadStatus / LibraryChatThreadView / ChatThreadSidecar) with
// neutral names so a `ThreadStore` host can persist them against any DB and the
// controller can drive a thread list / rename / archive / anchor-scoping surface
// without library or sizzle coupling.
//
// The controller OWNS the method surface (create/list/rename/archive); the host
// OWNS storage. These types are the contract between the two: the store returns
// `NormalizedThreadRecord`s (the persisted metadata), the controller derives a
// `NormalizedThreadView` (record + live status) for broadcast.

import type { ThreadId } from "./thread";

/** Where in its lifecycle a thread is, from the controller's point of view. The
 *  discriminated union makes impossible states (streaming AND awaiting-approval)
 *  unrepresentable. Generalizes PwrSnap's `LibraryChatThreadStatus`. */
export type NormalizedThreadStatus =
  | { kind: "idle" }
  | { kind: "streaming"; turnId: string }
  | { kind: "awaiting_approval"; approvalId: string };

/** One anchor-focus history entry: which subject (capture, project, document …)
 *  the thread was focused on, and when. Generalizes PwrSnap's `ChatFocusEntry`
 *  (`captureId` → `anchorId`). */
export type NormalizedAnchorEntry = {
  anchorId: string;
  /** ISO-8601 of when the thread was focused on this anchor. */
  at: string;
};

/** The persisted thread metadata the store reads/writes. Generalizes PwrSnap's
 *  `ChatThreadSidecar` with neutral names (`anchorCaptureId` → `anchorId`,
 *  `focusHistory` → `anchorHistory`). The per-turn message journal + attachments
 *  live elsewhere (the store's journal API); this is the INDEX row. */
export type NormalizedThreadRecord = {
  threadId: ThreadId;
  /** User-renameable display name. */
  name: string;
  /** ISO-8601. */
  createdAt: string;
  /** ISO-8601. Bumped on every metadata write. */
  modifiedAt: string;
  /** The subject the thread is currently anchored to, or null when unanchored
   *  (the anchor was never set / was cleared / the subject was deleted). */
  anchorId: string | null;
  /** Last N anchor-focus changes (capped by the store at write time). */
  anchorHistory: NormalizedAnchorEntry[];
  archived: boolean;
  pinned: boolean;
};

/** Derived, never parsed-from-disk: the record plus the controller's live
 *  status, broadcast to the host UI. Generalizes PwrSnap's
 *  `LibraryChatThreadView`. */
export type NormalizedThreadView = {
  threadId: ThreadId;
  name: string;
  createdAt: string;
  modifiedAt: string;
  anchorId: string | null;
  archived: boolean;
  pinned: boolean;
  /** Short preview of the last message for the thread-list row. */
  lastMessagePreview: string;
  status: NormalizedThreadStatus;
};

/** A thread directory minted by the store BEFORE the backend opens the thread,
 *  so the caller can pass the final workspace as the backend's cwd. `threadId`
 *  is absent until the backend assigns one (the store keys the dir off its own
 *  handle until then). Generalizes PwrSnap's `PreparedChatThreadDir`. */
export type PreparedThreadDir = {
  threadId?: string;
  /** Absolute path to the prepared directory. */
  path: string;
};

/** Filters for `ThreadStore.list`, pushed into the store's indexed query.
 *   • `includeArchived` omitted/false → archived rows excluded.
 *   • `anchorId` omitted → all anchors. `null` → only unanchored threads. A
 *     string → only that anchor's threads. */
export type ThreadListOptions = {
  includeArchived?: boolean;
  anchorId?: string | null;
};

/** Patch for `ThreadStore.update`. `undefined` / missing key = leave alone; an
 *  explicit value (including `false`) is a write — mirrors the `undefined ≠ value`
 *  rule. */
export type ThreadUpdatePatch = {
  name?: string;
  archived?: boolean;
  pinned?: boolean;
};

/** Args for `ThreadStore.create`. The store mints the index row (and, when a
 *  `preparedDir` is supplied, glues it to that directory). */
export type ThreadCreateOptions = {
  threadId: string;
  name: string;
  anchorId?: string | null;
  preparedDir?: PreparedThreadDir;
};
