import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { NormalizedApprovalRequest } from "@pwrdrvr/agent-core";
import { ChatApprovalModal } from "../src/index";

afterEach(() => {
  cleanup();
});

function execRequest(): NormalizedApprovalRequest {
  return {
    id: "appr-1",
    method: "exec_command_approval",
    kind: "exec",
    summary: "Run `rm -rf build`?",
    params: { command: "rm -rf build" }
  };
}

describe("ChatApprovalModal", () => {
  it("renders the approval summary", () => {
    render(<ChatApprovalModal request={execRequest()} onDecision={vi.fn()} />);
    expect(screen.getByTestId("ac-approval-summary").textContent).toBe("Run `rm -rf build`?");
    expect(screen.getByTestId("ac-approval").getAttribute("data-kind")).toBe("exec");
  });

  it("renders detail when provided", () => {
    render(
      <ChatApprovalModal
        request={execRequest()}
        onDecision={vi.fn()}
        detail="$ rm -rf build"
      />
    );
    expect(screen.getByTestId("ac-approval-detail").textContent).toBe("$ rm -rf build");
  });

  it("fires onDecision with id + 'approved' on Approve", () => {
    const onDecision = vi.fn();
    render(<ChatApprovalModal request={execRequest()} onDecision={onDecision} />);

    fireEvent.click(screen.getByTestId("ac-approval-approve"));
    expect(onDecision).toHaveBeenCalledWith("appr-1", "approved");
  });

  it("fires onDecision with id + 'denied' on Deny", () => {
    const onDecision = vi.fn();
    render(<ChatApprovalModal request={execRequest()} onDecision={onDecision} />);

    fireEvent.click(screen.getByTestId("ac-approval-deny"));
    expect(onDecision).toHaveBeenCalledWith("appr-1", "denied");
  });

  it("denies on Escape", () => {
    const onDecision = vi.fn();
    render(<ChatApprovalModal request={execRequest()} onDecision={onDecision} />);

    fireEvent.keyDown(window, { key: "Escape" });
    expect(onDecision).toHaveBeenCalledWith("appr-1", "denied");
  });

  it("guards against double-resolve", () => {
    // A pending (never-settling) promise keeps the modal busy.
    const onDecision = vi.fn(() => new Promise<void>(() => undefined));
    render(<ChatApprovalModal request={execRequest()} onDecision={onDecision} />);

    fireEvent.click(screen.getByTestId("ac-approval-approve"));
    fireEvent.click(screen.getByTestId("ac-approval-deny"));
    fireEvent.click(screen.getByTestId("ac-approval-approve"));

    expect(onDecision).toHaveBeenCalledTimes(1);
    expect(onDecision).toHaveBeenCalledWith("appr-1", "approved");
  });

  it("falls back to a generic summary when none is provided", () => {
    const request: NormalizedApprovalRequest = {
      id: "appr-2",
      method: "patch_approval",
      kind: "patch",
      params: {}
    };
    render(<ChatApprovalModal request={request} onDecision={vi.fn()} />);
    expect(screen.getByTestId("ac-approval-summary").textContent).toBe(
      "Approve patch request?"
    );
  });
});
