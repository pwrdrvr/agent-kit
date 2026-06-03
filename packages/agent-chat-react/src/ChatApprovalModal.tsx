// ChatApprovalModal — pure presentational modal that surfaces a single
// neutral `NormalizedApprovalRequest` and routes the user's decision back
// out through `onDecision`. NO bus / IPC / transport work — props in,
// callback out.
//
// Ported from PwrSnap's ChatApprovalModal (MIT) and re-targeted from
// PwrSnap's ChatApprovalRequest onto `@pwrdrvr/agent-core`'s
// `NormalizedApprovalRequest`, with the neutral decision vocabulary
// (`approved` | `denied` | `abort`). The host echoes the request `id` back
// to its backend when answering.
//
// Resolve guard: the moment the user picks a decision ALL buttons disable
// and a spinner shows until `onDecision` settles. A `resolvingRef` guard
// means a double-click — or a click on a second button before the first
// settles — can never resolve the same approval twice. The async path is
// awaited so a slow host keeps the modal busy rather than letting the user
// fire a second decision.

import { useCallback, useEffect, useRef, useState, type ReactElement } from "react";
import type {
  NormalizedApprovalRequest,
  NormalizedApprovalDecision
} from "@pwrdrvr/agent-core";

export interface ChatApprovalModalProps {
  /** The approval the agent is waiting on. */
  readonly request: NormalizedApprovalRequest;
  /** Resolve the approval with the user's decision. Receives the request
   *  `id` (so the host can correlate it to the backend) and the neutral
   *  decision. May be async — the modal stays busy until it settles. */
  readonly onDecision: (
    id: string,
    decision: NormalizedApprovalDecision
  ) => void | Promise<void>;
  /** Optional extra detail to render in a monospace block below the summary
   *  (e.g. a stringified command / patch the host derived from `params`).
   *  The kit does not interpret backend `params` itself. */
  readonly detail?: string;
}

type Phase = "idle" | "resolving";

export function ChatApprovalModal(props: ChatApprovalModalProps): ReactElement {
  const { request, onDecision, detail } = props;

  const [phase, setPhase] = useState<Phase>("idle");
  // Ref guard so the first click wins even if a second click lands in the
  // same tick (React state updates are async; the ref is not).
  const resolvingRef = useRef<boolean>(false);
  // Avoid a state update after unmount when `onDecision` settles late.
  const mountedRef = useRef<boolean>(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const resolve = useCallback(
    (decision: NormalizedApprovalDecision): void => {
      if (resolvingRef.current) return;
      resolvingRef.current = true;
      setPhase("resolving");
      void Promise.resolve(onDecision(request.id, decision)).finally(() => {
        // Leave the ref latched — once an approval is resolved it does not
        // re-arm; the parent unmounts the modal on the next render.
        if (mountedRef.current) setPhase("idle");
      });
    },
    [onDecision, request.id]
  );

  const onApprove = useCallback((): void => resolve("approved"), [resolve]);
  const onDeny = useCallback((): void => resolve("denied"), [resolve]);

  // Escape = Deny. Window-level so the modal catches it regardless of which
  // child holds focus.
  useEffect(() => {
    const handler = (event: KeyboardEvent): void => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      resolve("denied");
    };
    window.addEventListener("keydown", handler);
    return () => {
      window.removeEventListener("keydown", handler);
    };
  }, [resolve]);

  const busy = phase === "resolving";
  const titleId = `ac-approval-title-${request.id}`;
  const summary =
    request.summary !== undefined && request.summary !== ""
      ? request.summary
      : `Approve ${request.kind} request?`;

  return (
    <div className="ac-approval-scrim" data-testid="ac-approval-scrim">
      <div
        className="ac-approval"
        role="dialog"
        aria-modal="true"
        aria-label="Agent approval"
        aria-labelledby={titleId}
        aria-busy={busy}
        data-testid="ac-approval"
        data-kind={request.kind}
      >
        <p id={titleId} className="ac-approval__summary" data-testid="ac-approval-summary">
          {summary}
        </p>
        {detail !== undefined && detail !== "" ? (
          <pre className="ac-approval__detail" data-testid="ac-approval-detail">
            {detail}
          </pre>
        ) : null}
        <div className="ac-approval__actions">
          <button
            type="button"
            className="ac-approval__btn ac-approval__btn--deny"
            onClick={onDeny}
            disabled={busy}
            data-testid="ac-approval-deny"
          >
            Deny
          </button>
          <button
            type="button"
            className="ac-approval__btn ac-approval__btn--approve"
            onClick={onApprove}
            disabled={busy}
            data-testid="ac-approval-approve"
          >
            {busy ? (
              <span
                className="ac-approval__spinner"
                role="status"
                aria-label="Resolving"
                data-testid="ac-approval-spinner"
              />
            ) : (
              "Approve"
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
