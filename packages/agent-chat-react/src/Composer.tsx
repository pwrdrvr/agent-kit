// Composer — the message-input row for an agent-kit chat surface. PURE
// PRESENTATIONAL: props in, callbacks out. No bus / IPC / transport wiring —
// the host's `onSubmit` decides what to do with the text.
//
// Ported from PwrSnap's Composer (MIT), trimmed to the neutral surface:
// the PwrSnap-specific image paste/drop attachment pipeline (objectURL
// previews, the Library window's global-drop coordination) and the
// keyboard-chord-shadowing listener were host-specific and are dropped.
// What's kept is generic and load-bearing:
//
//   • Multiline <textarea> that auto-grows to its content, capped at ~40vh
//     then scrolls. ⏎ submits; ⇧⏎ inserts a newline; IME composition never
//     submits. Empty / whitespace-only input never submits.
//
//   • Double-submit guard: a `submitInFlight` ref + a two-state machine
//     ("idle" | "sending"). A second ⏎ while a submit is in flight is a
//     no-op and does NOT clear the textarea — the user's draft survives a
//     slow / failed send. The textarea clears and the machine returns to
//     "idle" in a `.finally()` so it recovers on BOTH resolve and reject.
//
//   • While the host reports a turn is `streaming`, the send button becomes
//     an Interrupt button wired to `onInterrupt` so the user can stop the
//     agent mid-turn. The textarea is disabled while streaming.

import {
  useCallback,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ChangeEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactElement
} from "react";

export interface ComposerProps {
  /** Called when the user submits a non-empty message. May return a promise;
   *  while pending the composer is in the SENDING state and further submits
   *  are no-ops. Resolve clears the textarea; reject keeps the draft so the
   *  user can retry. */
  readonly onSubmit: (text: string) => void | Promise<void>;
  /** Whether a turn is currently streaming. When true the textarea is
   *  disabled and the send button becomes an Interrupt button (if
   *  `onInterrupt` is provided). */
  readonly streaming?: boolean;
  /** Stop the in-flight turn. When provided and `streaming` is true, the
   *  send button renders as Interrupt and calls this. */
  readonly onInterrupt?: () => void;
  /** Fully disable the composer (e.g. no agent connected). Disables the
   *  textarea AND the send button. */
  readonly disabled?: boolean;
  readonly placeholder?: string;
  /** Test-id prefix. Defaults to "composer". */
  readonly testIdPrefix?: string;
}

type SendState = "idle" | "sending";

/** Cap the auto-grow at ~40vh, then the textarea scrolls. Read once per
 *  measure so a resized window stays correct. */
function maxTextareaHeightPx(): number {
  if (typeof window === "undefined") return 320;
  return Math.round(window.innerHeight * 0.4);
}

export function Composer(props: ComposerProps): ReactElement {
  const {
    onSubmit,
    streaming = false,
    onInterrupt,
    disabled = false,
    placeholder = "Send a message…",
    testIdPrefix = "composer"
  } = props;

  const [text, setText] = useState<string>("");
  const [sendState, setSendState] = useState<SendState>("idle");

  // Double-submit guard. The ref is the authority for the keydown / click
  // handlers (it's synchronous — a second ⏎ in the same tick sees `true`
  // before React re-renders the state). `sendState` mirrors it for styling.
  const submitInFlight = useRef<boolean>(false);

  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  // Live mirrors so the handlers read the latest text / disabled without
  // re-binding on every keystroke.
  const textRef = useRef<string>(text);
  textRef.current = text;
  const disabledRef = useRef<boolean>(disabled || streaming);
  disabledRef.current = disabled || streaming;

  const errId = useId();

  // ---- auto-grow ---------------------------------------------------
  // Measure on every text change: reset to auto, read scrollHeight, clamp to
  // the 40vh ceiling. useLayoutEffect so the resize happens before paint.
  useLayoutEffect(() => {
    const el = textareaRef.current;
    if (el === null) return;
    el.style.height = "auto";
    const max = maxTextareaHeightPx();
    const next = Math.min(el.scrollHeight, max);
    el.style.height = `${next}px`;
    el.style.overflowY = el.scrollHeight > max ? "auto" : "hidden";
  }, [text]);

  // ---- submit ------------------------------------------------------
  const textareaDisabled = disabled || streaming;
  const canSubmit = !textareaDisabled && sendState === "idle" && text.trim().length > 0;

  const doSubmit = useCallback((): void => {
    // Synchronous guard: a second ⏎ in the same tick reads the ref, not the
    // not-yet-committed state.
    if (submitInFlight.current) return;
    if (disabledRef.current) return;
    const trimmed = textRef.current.trim();
    if (trimmed.length === 0) return;

    submitInFlight.current = true;
    setSendState("sending");

    void Promise.resolve(onSubmit(trimmed))
      .then(() => {
        // Success: clear the draft.
        setText("");
      })
      .catch(() => {
        // Failure: keep the draft so the user can retry.
      })
      .finally(() => {
        submitInFlight.current = false;
        setSendState("idle");
      });
  }, [onSubmit]);

  const handleKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLTextAreaElement>): void => {
      if (event.key !== "Enter") return;
      // ⇧⏎ → newline (let the textarea handle it).
      if (event.shiftKey) return;
      // IME composition mid-flight should not submit (CJK input).
      if (event.nativeEvent.isComposing) return;
      event.preventDefault();
      doSubmit();
    },
    [doSubmit]
  );

  const handleChange = useCallback((event: ChangeEvent<HTMLTextAreaElement>): void => {
    setText(event.target.value);
  }, []);

  const showInterrupt = streaming && onInterrupt !== undefined;
  const isSending = sendState === "sending";

  return (
    <div
      className="ac-composer"
      data-testid={`${testIdPrefix}-root`}
      data-state={sendState}
      data-streaming={streaming ? "true" : "false"}
    >
      <div className="ac-composer__row">
        <textarea
          ref={textareaRef}
          className="ac-composer__input"
          rows={1}
          value={text}
          placeholder={placeholder}
          disabled={textareaDisabled}
          aria-label="Message"
          aria-describedby={errId}
          aria-disabled={textareaDisabled}
          data-testid={`${testIdPrefix}-input`}
          onChange={handleChange}
          onKeyDown={handleKeyDown}
        />
        {showInterrupt ? (
          <button
            type="button"
            className="ac-composer__interrupt"
            aria-label="Stop"
            title="Stop"
            data-testid={`${testIdPrefix}-interrupt`}
            onClick={onInterrupt}
          >
            <StopGlyph />
          </button>
        ) : (
          <button
            type="button"
            className="ac-composer__send"
            disabled={!canSubmit}
            aria-label="Send"
            title="Send"
            data-testid={`${testIdPrefix}-send`}
            onClick={doSubmit}
          >
            {isSending ? <SpinnerGlyph /> : <SendGlyph />}
          </button>
        )}
      </div>
    </div>
  );
}

function SendGlyph(): ReactElement {
  // Paper-plane.
  return (
    <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
      <path
        d="M1.5 8 14 2 9 14l-2.4-4.2L1.5 8Z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinejoin="round"
        strokeLinecap="round"
      />
    </svg>
  );
}

function StopGlyph(): ReactElement {
  return (
    <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
      <rect x="4" y="4" width="8" height="8" rx="1.5" fill="currentColor" />
    </svg>
  );
}

function SpinnerGlyph(): ReactElement {
  return (
    <svg
      className="ac-composer__spinner"
      viewBox="0 0 16 16"
      width="16"
      height="16"
      aria-hidden="true"
    >
      <circle
        cx="8"
        cy="8"
        r="6"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeOpacity="0.25"
      />
      <path
        d="M8 2a6 6 0 0 1 6 6"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
      />
    </svg>
  );
}
