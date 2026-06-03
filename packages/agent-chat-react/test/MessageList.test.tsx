import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type {
  NormalizedThreadEntry,
  NormalizedActivityEntry,
  NormalizedMessageEntry
} from "@pwrdrvr/agent-core";
import { MessageList, type SubscribeToStream } from "../src/index";

afterEach(() => {
  cleanup();
});

function userMessage(id: string, text: string): NormalizedMessageEntry {
  return { type: "message", id, role: "user", text };
}

function assistantMessage(id: string, text: string): NormalizedMessageEntry {
  return { type: "message", id, role: "assistant", text };
}

function toolActivity(
  id: string,
  toolName: string,
  status: NormalizedActivityEntry["toolCalls"][number]["status"],
  summary = "Ran a tool"
): NormalizedActivityEntry {
  return {
    type: "activity",
    id,
    summary,
    toolCalls: [
      {
        id: `${id}-call`,
        name: toolName,
        kind: "read",
        label: toolName,
        status,
        args: { path: "canvas.json" }
      }
    ]
  };
}

describe("MessageList", () => {
  it("renders a user message, an assistant message, and a tool-call activity card", () => {
    const entries: NormalizedThreadEntry[] = [
      userMessage("u1", "Describe this image"),
      assistantMessage("a1", "Here is a description."),
      toolActivity("act1", "read_canvas", "completed", "Looked at the canvas")
    ];

    render(<MessageList entries={entries} />);

    // User + assistant text.
    expect(screen.getByText("Describe this image")).toBeDefined();
    expect(screen.getByText("Here is a description.")).toBeDefined();

    // Activity summary + tool name + completed status.
    expect(screen.getByText("Looked at the canvas")).toBeDefined();
    expect(screen.getByTestId("message-list-tool-name").textContent).toBe("read_canvas");

    const card = screen.getByTestId("message-list-tool-act1-call");
    expect(card.getAttribute("data-state")).toBe("success");
    expect(card.getAttribute("data-status")).toBe("completed");

    // Roles are reflected on the bubbles.
    expect(screen.getByTestId("message-list-msg-u1").getAttribute("data-role")).toBe("user");
    expect(screen.getByTestId("message-list-msg-a1").getAttribute("data-role")).toBe(
      "assistant"
    );
  });

  it("renders an in-progress tool-call card with a spinner and in_progress state", () => {
    const entries: NormalizedThreadEntry[] = [
      toolActivity("act2", "run_command", "in_progress", "Running a command")
    ];

    render(<MessageList entries={entries} />);

    const card = screen.getByTestId("message-list-tool-act2-call");
    expect(card.getAttribute("data-state")).toBe("in_progress");
    expect(card.getAttribute("data-status")).toBe("in_progress");
    expect(screen.getByTestId("message-list-tool-spinner")).toBeDefined();
  });

  it("expands a tool card to show args + result", () => {
    const entries: NormalizedThreadEntry[] = [
      {
        type: "activity",
        id: "act3",
        summary: "Searched",
        toolCalls: [
          {
            id: "c3",
            name: "search",
            kind: "search",
            label: "search",
            status: "completed",
            args: { query: "cats" },
            result: { hits: 2 }
          }
        ]
      }
    ];

    render(<MessageList entries={entries} />);

    fireEvent.click(screen.getByTestId("message-list-tool-toggle-c3"));

    const args = screen.getByTestId("message-list-tool-args-c3");
    expect(args.textContent).toContain("\"query\": \"cats\"");
    const result = screen.getByTestId("message-list-tool-result-c3");
    expect(result.textContent).toContain("\"hits\": 2");
  });

  it("streams assistant text incrementally via subscribeToStream", async () => {
    // A holder object defeats TS control-flow narrowing of the closed-over
    // callback (assigned inside the vi.fn mock TS can't track).
    const stream: { emit: ((fullText: string) => void) | null } = { emit: null };
    const subscribe: SubscribeToStream = vi.fn((_entryId, onDelta) => {
      stream.emit = onDelta;
      return () => {
        stream.emit = null;
      };
    });

    // jsdom: drive rAF off a macrotask so the component's `rafRef` handle is
    // assigned BEFORE the flush runs (matching real browser ordering — a
    // synchronous mock would leave a stale handle and drop later deltas).
    let rafId = 0;
    const rafSpy = vi
      .spyOn(globalThis, "requestAnimationFrame")
      .mockImplementation((cb: FrameRequestCallback): number => {
        rafId += 1;
        setTimeout(() => cb(0), 0);
        return rafId;
      });
    const cafSpy = vi
      .spyOn(globalThis, "cancelAnimationFrame")
      .mockImplementation(() => undefined);

    const entries: NormalizedThreadEntry[] = [assistantMessage("a-stream", "")];

    render(
      <MessageList
        entries={entries}
        streamingEntryId="a-stream"
        subscribeToStream={subscribe}
      />
    );

    expect(subscribe).toHaveBeenCalledWith("a-stream", expect.any(Function));

    // The flush (and its state update) lands on a later macrotask + a
    // possible useDeferredValue tick — poll for it.
    stream.emit?.("Hel");
    await waitFor(() => {
      expect(screen.getByTestId("message-list-streaming").textContent).toContain("Hel");
    });

    stream.emit?.("Hello world");
    await waitFor(() => {
      expect(screen.getByTestId("message-list-streaming").textContent).toContain(
        "Hello world"
      );
    });

    rafSpy.mockRestore();
    cafSpy.mockRestore();
  });

  it("renders a thinking indicator when thinking is true", () => {
    render(<MessageList entries={[]} thinking />);
    expect(screen.getByTestId("message-list-pending")).toBeDefined();
    expect(screen.getByText("Thinking…")).toBeDefined();
  });

  it("renders plan steps with their statuses", () => {
    const entries: NormalizedThreadEntry[] = [
      {
        type: "plan",
        id: "plan1",
        steps: [
          { step: "Read the file", status: "completed" },
          { step: "Edit the file", status: "in_progress" },
          { step: "Run tests", status: "pending" }
        ]
      }
    ];

    render(<MessageList entries={entries} />);

    const steps = screen.getAllByTestId("message-list-plan-step");
    expect(steps).toHaveLength(3);
    expect(steps[0]?.getAttribute("data-status")).toBe("completed");
    expect(steps[1]?.getAttribute("data-status")).toBe("in_progress");
    expect(steps[2]?.getAttribute("data-status")).toBe("pending");
    expect(screen.getByText("Edit the file")).toBeDefined();
  });

  it("shows a Retry control on a failed message and fires onRetry", () => {
    const onRetry = vi.fn();
    const entries: NormalizedThreadEntry[] = [
      {
        type: "message",
        id: "f1",
        role: "assistant",
        text: "partial",
        turn: { id: "t1", status: "failed" }
      }
    ];

    render(<MessageList entries={entries} onRetry={onRetry} />);

    fireEvent.click(screen.getByTestId("message-list-retry-f1"));
    expect(onRetry).toHaveBeenCalledWith("f1");
  });
});
