// MessageList — the presentational streaming transcript for agent-kit chat
// surfaces. PURE PRESENTATIONAL: props in, callbacks out, NO bus / IPC /
// transport wiring. The host owns the delta source and the thread log; this
// component renders the kit's neutral `NormalizedThreadEntry[]` and emits
// only the intents a transcript can produce (retry, jump-to-latest).
//
// Ported from PwrSnap's MessageList (MIT) and re-targeted from PwrSnap's
// ChatMessage/run model onto `@pwrdrvr/agent-core`'s neutral thread shapes:
//   • message entries  → NormalizedMessageEntry (user / assistant / system)
//   • activity entries → NormalizedActivityEntry (a row of NormalizedToolCall)
//   • plan entries     → NormalizedPlanEntry
//
// Streaming-perf design (preserved from the source):
//
//   1. The streaming assistant text is rendered by a SEPARATE child
//      (`StreamingText`) that owns its own local state. It subscribes to
//      deltas via `subscribeToStream`, buffers the latest full text in a
//      ref, and flushes to local state at most ONCE PER FRAME via
//      requestAnimationFrame. The static list above never re-renders while
//      tokens stream. `useDeferredValue` lets React coalesce under load.
//
//   2. Every entry carries `contain: layout` (see MessageList.css) so a
//      streaming entry growing at the bottom can't force a layout recalc of
//      the completed entries above it.
//
// Content safety: text renders as PLAIN TEXT (React escapes by default —
// never dangerouslySetInnerHTML). A model that emits `<img onerror=...>`
// renders as literal characters.
//
// Sticky-bottom-only-if-at-bottom: auto-scroll to the latest content ONLY
// when the user is already within ~64px of the bottom. If they've scrolled
// up we never yank them down; a "Jump to latest ↓" affordance appears.

import {
  memo,
  useCallback,
  useDeferredValue,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactElement,
  type ReactNode
} from "react";
import type {
  NormalizedThreadEntry,
  NormalizedActivityEntry,
  NormalizedMessageEntry,
  NormalizedPlanEntry,
  NormalizedToolCall,
  NormalizedToolStatus,
  NormalizedTurnStatus
} from "@pwrdrvr/agent-core";

/** Subscribe to streaming deltas for one entry. The host owns the delta
 *  source; MessageList coalesces via rAF. The callback receives the FULL
 *  accumulated text each delta (not an incremental chunk). Returns an
 *  unsubscribe fn. */
export type SubscribeToStream = (
  entryId: string,
  onDelta: (fullText: string) => void
) => () => void;

export interface MessageListProps {
  /** The neutral transcript to render, in order. */
  readonly entries: readonly NormalizedThreadEntry[];
  /** The id of the message entry currently streaming, if any. When set and
   *  `subscribeToStream` is provided, that entry renders a live caret and
   *  appends streamed deltas after its committed text. */
  readonly streamingEntryId?: string | null;
  /** Subscribe to streamed deltas for the streaming entry (see type). */
  readonly subscribeToStream?: SubscribeToStream;
  /** Show a trailing "Thinking…" indicator after the last entry (e.g. the
   *  turn is in flight but no assistant text has arrived yet). */
  readonly thinking?: boolean;
  /** Retry a failed message entry (optional). When provided, an entry whose
   *  turn status is `failed` shows a Retry control wired to this. */
  readonly onRetry?: (entryId: string) => void;
  /** Test-id prefix. Defaults to `message-list`. */
  readonly testIdPrefix?: string;
}

/** How close (px) to the bottom the user must be for new content to
 *  auto-scroll. Above this gap we show the "Jump to latest" pill instead. */
const STICK_THRESHOLD_PX = 64;

export function MessageList(props: MessageListProps): ReactElement {
  const {
    entries,
    streamingEntryId = null,
    subscribeToStream,
    thinking = false,
    onRetry,
    testIdPrefix = "message-list"
  } = props;

  const scrollRef = useRef<HTMLDivElement | null>(null);
  // True while the viewport is pinned to the bottom. Drives whether new
  // content auto-scrolls. Starts true (fresh thread shows latest).
  const atBottomRef = useRef<boolean>(true);
  const [atBottom, setAtBottom] = useState<boolean>(true);

  const measureAtBottom = useCallback((): boolean => {
    const el = scrollRef.current;
    if (el === null) return true;
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
    return distance <= STICK_THRESHOLD_PX;
  }, []);

  const scrollToBottom = useCallback((): void => {
    const el = scrollRef.current;
    if (el === null) return;
    el.scrollTop = el.scrollHeight;
  }, []);

  const handleScroll = useCallback((): void => {
    const next = measureAtBottom();
    if (next !== atBottomRef.current) {
      atBottomRef.current = next;
      setAtBottom(next);
    }
  }, [measureAtBottom]);

  // On new entries (count change) — or the thinking indicator toggling —
  // auto-scroll only if we were pinned. Reads the ref, not the state, so we
  // react to the freshest position.
  useLayoutEffect(() => {
    if (atBottomRef.current) {
      scrollToBottom();
    }
  }, [entries.length, thinking, scrollToBottom]);

  // Called by the streaming text after each rAF flush so the viewport tracks
  // growing streamed content — but only while pinned.
  const handleStreamGrow = useCallback((): void => {
    if (atBottomRef.current) {
      scrollToBottom();
    }
  }, [scrollToBottom]);

  const jumpToLatest = useCallback((): void => {
    scrollToBottom();
    atBottomRef.current = true;
    setAtBottom(true);
  }, [scrollToBottom]);

  return (
    <div className="ml" data-testid={testIdPrefix}>
      <div
        ref={scrollRef}
        className="ml__scroll"
        onScroll={handleScroll}
        data-testid={`${testIdPrefix}-scroll`}
        role="log"
        aria-live="polite"
        aria-label="Chat messages"
      >
        {entries.map((entry) => (
          <EntryView
            key={entry.id}
            entry={entry}
            isStreaming={entry.type === "message" && streamingEntryId === entry.id}
            subscribeToStream={subscribeToStream}
            onStreamGrow={handleStreamGrow}
            onRetry={onRetry}
            testIdPrefix={testIdPrefix}
          />
        ))}

        {thinking && (
          <div
            className="ml__msg ml__msg--assistant ml__msg--pending"
            data-testid={`${testIdPrefix}-pending`}
          >
            <div className="ml__bubble">
              <div className="ml__thinking" aria-live="polite">
                <span className="ml__thinking-dot" aria-hidden="true" />
                Thinking…
              </div>
            </div>
          </div>
        )}
      </div>

      {!atBottom && (
        <button
          type="button"
          className="ml__jump"
          onClick={jumpToLatest}
          data-testid={`${testIdPrefix}-jump`}
        >
          Jump to latest
          <span className="ml__jump-arrow" aria-hidden="true">
            ↓
          </span>
        </button>
      )}
    </div>
  );
}

interface EntryViewProps {
  entry: NormalizedThreadEntry;
  isStreaming: boolean;
  subscribeToStream: SubscribeToStream | undefined;
  onStreamGrow: () => void;
  onRetry: ((entryId: string) => void) | undefined;
  testIdPrefix: string;
}

// Memoized so a completed entry never re-renders while a later entry
// streams. The streaming text is the ONLY child that re-renders per frame;
// its own internal state (not props) drives that, so this memo boundary
// holds even as the parent's `entries` array identity changes.
const EntryView = memo(function EntryView(props: EntryViewProps): ReactElement | null {
  const { entry, isStreaming, subscribeToStream, onStreamGrow, onRetry, testIdPrefix } = props;

  if (entry.type === "message") {
    return (
      <MessageBubble
        entry={entry}
        isStreaming={isStreaming}
        subscribeToStream={subscribeToStream}
        onStreamGrow={onStreamGrow}
        onRetry={onRetry}
        testIdPrefix={testIdPrefix}
      />
    );
  }
  if (entry.type === "activity") {
    return <ActivityCard entry={entry} testIdPrefix={testIdPrefix} />;
  }
  return <PlanCard entry={entry} testIdPrefix={testIdPrefix} />;
});

interface MessageBubbleProps {
  entry: NormalizedMessageEntry;
  isStreaming: boolean;
  subscribeToStream: SubscribeToStream | undefined;
  onStreamGrow: () => void;
  onRetry: ((entryId: string) => void) | undefined;
  testIdPrefix: string;
}

function MessageBubble(props: MessageBubbleProps): ReactElement {
  const { entry, isStreaming, subscribeToStream, onStreamGrow, onRetry, testIdPrefix } = props;
  const status = entry.turn?.status;

  return (
    <div
      className={`ml__msg ml__msg--${entry.role}`}
      data-testid={`${testIdPrefix}-msg-${entry.id}`}
      data-role={entry.role}
      data-status={status ?? ""}
    >
      <div className="ml__bubble">
        {entry.text !== "" && (
          <p className="ml__text" data-testid={`${testIdPrefix}-text`}>
            {entry.text}
          </p>
        )}

        {isStreaming && subscribeToStream !== undefined && (
          <StreamingText
            entryId={entry.id}
            subscribeToStream={subscribeToStream}
            onGrow={onStreamGrow}
            testIdPrefix={testIdPrefix}
          />
        )}

        <StatusFooter
          status={status}
          entryId={entry.id}
          onRetry={onRetry}
          testIdPrefix={testIdPrefix}
        />
      </div>
    </div>
  );
}

interface ActivityCardProps {
  entry: NormalizedActivityEntry;
  testIdPrefix: string;
}

function ActivityCard({ entry, testIdPrefix }: ActivityCardProps): ReactElement {
  return (
    <div
      className="ml__msg ml__msg--assistant"
      data-testid={`${testIdPrefix}-activity-${entry.id}`}
      data-role="activity"
      data-status={entry.status ?? ""}
    >
      <div className="ml__bubble">
        {entry.summary !== "" && (
          <p className="ml__activity-summary" data-testid={`${testIdPrefix}-activity-summary`}>
            {entry.summary}
          </p>
        )}
        {entry.toolCalls.map((call) => (
          <ToolCard key={call.id} call={call} testIdPrefix={testIdPrefix} />
        ))}
      </div>
    </div>
  );
}

interface PlanCardProps {
  entry: NormalizedPlanEntry;
  testIdPrefix: string;
}

function PlanCard({ entry, testIdPrefix }: PlanCardProps): ReactElement {
  return (
    <div
      className="ml__msg ml__msg--assistant"
      data-testid={`${testIdPrefix}-plan-${entry.id}`}
      data-role="plan"
    >
      <div className="ml__bubble ml__plan">
        {entry.explanation !== undefined && entry.explanation !== "" && (
          <p className="ml__plan-explanation">{entry.explanation}</p>
        )}
        <ol className="ml__plan-steps">
          {entry.steps.map((step, index) => (
            <li
              key={`${entry.id}:${index}`}
              className={`ml__plan-step ml__plan-step--${step.status}`}
              data-status={step.status}
              data-testid={`${testIdPrefix}-plan-step`}
            >
              <span className="ml__plan-step-mark" aria-hidden="true">
                {step.status === "completed" ? "✓" : step.status === "in_progress" ? "◐" : "○"}
              </span>
              <span className="ml__plan-step-text">{step.step}</span>
            </li>
          ))}
        </ol>
      </div>
    </div>
  );
}

type ToolCardState = "in_progress" | "success" | "error";

function toolCardState(status: NormalizedToolStatus): ToolCardState {
  if (status === "completed") return "success";
  if (status === "failed" || status === "cancelled") return "error";
  return "in_progress";
}

interface ToolCardProps {
  call: NormalizedToolCall;
  testIdPrefix: string;
}

function ToolCard({ call, testIdPrefix }: ToolCardProps): ReactElement {
  const [open, setOpen] = useState<boolean>(false);
  const state = toolCardState(call.status);

  const hasArgs = call.args !== undefined;
  const hasResult = call.result !== undefined;

  return (
    <div
      className={`ml__tool ml__tool--${state}`}
      data-testid={`${testIdPrefix}-tool-${call.id}`}
      data-state={state}
      data-status={call.status}
    >
      <button
        type="button"
        className="ml__tool-head"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        data-testid={`${testIdPrefix}-tool-toggle-${call.id}`}
      >
        <span className={`ml__tool-tri${open ? " is-open" : ""}`} aria-hidden="true">
          ▸
        </span>
        <span className="ml__tool-name" data-testid={`${testIdPrefix}-tool-name`}>
          {call.label !== "" ? call.label : call.name}
        </span>
        <span className="ml__tool-state" aria-hidden="true">
          {state === "in_progress" && (
            <span className="ml__spinner" data-testid={`${testIdPrefix}-tool-spinner`} />
          )}
          {state === "success" && <span className="ml__tool-ok">✓</span>}
          {state === "error" && <span className="ml__tool-err">✕</span>}
        </span>
      </button>

      {open && (hasArgs || hasResult) && (
        <div className="ml__tool-body">
          {hasArgs && (
            <div className="ml__tool-section">
              <span className="ml__tool-label">Arguments</span>
              <pre className="ml__code" data-testid={`${testIdPrefix}-tool-args-${call.id}`}>
                {prettyValue(call.args)}
              </pre>
            </div>
          )}
          {hasResult && (
            <div className="ml__tool-section">
              <span className="ml__tool-label">{state === "error" ? "Error" : "Result"}</span>
              <pre className="ml__code" data-testid={`${testIdPrefix}-tool-result-${call.id}`}>
                {prettyValue(call.result)}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// Pretty-print a tool arg/result for display. Strings render as-is (they may
// be partial stream snapshots); everything else is JSON-stringified. Never
// throws at render time.
function prettyValue(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

interface StreamingTextProps {
  entryId: string;
  subscribeToStream: SubscribeToStream;
  onGrow: () => void;
  testIdPrefix: string;
}

// The ONLY component that re-renders per streamed delta. It subscribes to the
// host's delta source, buffers the latest full text in a ref, and flushes
// that ref into local state on a SINGLE requestAnimationFrame per frame
// (coalescing a burst of deltas into one paint). `useDeferredValue` lets
// React further de-prioritize the render under load.
function StreamingText({
  entryId,
  subscribeToStream,
  onGrow,
  testIdPrefix
}: StreamingTextProps): ReactElement {
  const [text, setText] = useState<string>("");

  const bufferRef = useRef<string>("");
  const rafRef = useRef<number | null>(null);
  const canceledRef = useRef<boolean>(false);
  const onGrowRef = useRef(onGrow);
  onGrowRef.current = onGrow;

  useEffect(() => {
    canceledRef.current = false;

    const flush = (): void => {
      rafRef.current = null;
      if (canceledRef.current) return;
      setText(bufferRef.current);
      onGrowRef.current();
    };

    const onDelta = (fullText: string): void => {
      if (canceledRef.current) return;
      bufferRef.current = fullText;
      if (rafRef.current === null) {
        // jsdom (tests) has no rAF callback timing guarantees but provides the
        // function; in a real browser this coalesces a delta burst per frame.
        rafRef.current = requestAnimationFrame(flush);
      }
    };

    const unsubscribe = subscribeToStream(entryId, onDelta);

    return () => {
      canceledRef.current = true;
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
      unsubscribe();
    };
  }, [entryId, subscribeToStream]);

  const deferred = useDeferredValue(text);

  return (
    <p
      className="ml__text ml__text--streaming"
      data-testid={`${testIdPrefix}-streaming`}
      aria-live="polite"
    >
      {deferred}
      <span className="ml__caret" aria-hidden="true" />
    </p>
  );
}

interface StatusFooterProps {
  status: NormalizedTurnStatus | undefined;
  entryId: string;
  onRetry: ((entryId: string) => void) | undefined;
  testIdPrefix: string;
}

function StatusFooter({ status, entryId, onRetry, testIdPrefix }: StatusFooterProps): ReactNode {
  if (status === "failed") {
    return (
      <div className="ml__status ml__status--failed">
        <span className="ml__status-text">Failed</span>
        {onRetry !== undefined && (
          <button
            type="button"
            className="ml__retry"
            onClick={() => onRetry(entryId)}
            data-testid={`${testIdPrefix}-retry-${entryId}`}
          >
            Retry
          </button>
        )}
      </div>
    );
  }

  if (status === "interrupted") {
    return (
      <div
        className="ml__status ml__status--interrupted"
        data-testid={`${testIdPrefix}-interrupted-${entryId}`}
      >
        <span className="ml__status-text">Interrupted</span>
      </div>
    );
  }

  if (status === "cancelled") {
    return (
      <div
        className="ml__status ml__status--interrupted"
        data-testid={`${testIdPrefix}-cancelled-${entryId}`}
      >
        <span className="ml__status-text">Cancelled</span>
      </div>
    );
  }

  return null;
}
