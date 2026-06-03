import { describe, it, expect } from "vitest";
import {
  isThreadEventKind,
  inferToolKind,
  createEmptyThread,
  noopLogger,
  systemClock,
  type NormalizedThreadEvent,
  type NormalizedToolCall,
  type NormalizedThread,
  type NormalizedThreadSummary,
  type NormalizedUsageRecord,
  type ThreadStore,
  type ThreadId
} from "../src/index";

describe("NormalizedThreadEvent union", () => {
  it("represents a Codex-shaped turn lifecycle and narrows by kind", () => {
    const stream: NormalizedThreadEvent[] = [
      { kind: "turn_started", threadId: "t1", turnId: "u1" },
      { kind: "agent_message_delta", threadId: "t1", turnId: "u1", itemId: "i1", delta: "Hello" },
      {
        kind: "tool_call",
        threadId: "t1",
        turnId: "u1",
        toolCall: { id: "c1", name: "library_search", kind: "search", label: "search", status: "in_progress" }
      },
      {
        kind: "tool_call_update",
        threadId: "t1",
        turnId: "u1",
        toolCall: { id: "c1", status: "completed" }
      },
      { kind: "token_usage", threadId: "t1", turnId: "u1", usage: { inputTokens: 10, outputTokens: 5 } },
      { kind: "thread_settings", settings: { threadId: "t1", model: "gpt-5", serviceTier: null } },
      { kind: "turn_completed", threadId: "t1", turnId: "u1", status: "completed" }
    ];

    expect(stream).toHaveLength(7);

    const first = stream[0]!;
    expect(isThreadEventKind(first, "turn_started")).toBe(true);
    expect(isThreadEventKind(first, "tool_call")).toBe(false);

    // narrowing yields the precise member type
    let deltaText = "";
    for (const event of stream) {
      if (isThreadEventKind(event, "agent_message_delta")) {
        deltaText += event.delta; // typed access, no cast
      }
    }
    expect(deltaText).toBe("Hello");
  });

  it("represents an approval request and an error event", () => {
    const approval: NormalizedThreadEvent = {
      kind: "approval_request",
      threadId: "t1",
      approval: { id: "a1", method: "exec/approval", kind: "exec", params: { command: "rm -rf x" } }
    };
    const err: NormalizedThreadEvent = { kind: "error", threadId: "t1", message: "boom", code: "E_TURN" };
    expect(isThreadEventKind(approval, "approval_request")).toBe(true);
    expect(isThreadEventKind(err, "error")).toBe(true);
  });
});

describe("NormalizedToolCall mapping", () => {
  it("maps an ACP-shaped tool call onto the neutral shape with inferred kind", () => {
    // An ACP agent reports a tool call in its own (snake_case) shape; the adapter
    // would normalize it. The neutral target is lossless and kind-inferred here.
    const acpRaw = { tool_call_id: "tc_9", title: "Run tests", raw_input: { cmd: "pnpm test" } };
    const normalized: NormalizedToolCall = {
      id: acpRaw.tool_call_id,
      name: "run_tests",
      kind: inferToolKind("run_tests"),
      label: acpRaw.title,
      status: "in_progress",
      args: acpRaw.raw_input
    };
    expect(normalized.id).toBe("tc_9");
    expect(normalized.kind).toBe("command");
    expect(normalized.label).toBe("Run tests");
  });
});

describe("interfaces", () => {
  it("an in-memory ThreadStore satisfies the seam", async () => {
    const usage: NormalizedUsageRecord[] = [];
    const threads = new Map<ThreadId, NormalizedThread>();

    const store: ThreadStore = {
      async recordUsage(record) {
        usage.push(record);
      },
      async saveThread(thread) {
        threads.set(thread.id, thread);
      },
      async loadThread(id) {
        return threads.get(id) ?? null;
      },
      async listThreads(): Promise<NormalizedThreadSummary[]> {
        return [...threads.values()].map((t) =>
          t.status === undefined ? { id: t.id } : { id: t.id, status: t.status }
        );
      }
    };

    const thread = createEmptyThread("t1");
    expect(thread).toEqual({ id: "t1", entries: [], messages: [], status: "active" });

    await store.saveThread(thread);
    await store.recordUsage({ threadId: "t1", turnId: "u1", usage: { totalTokens: 15 } });

    expect(await store.loadThread("t1")).toEqual(thread);
    expect(await store.loadThread("missing")).toBeNull();
    expect(await store.listThreads()).toEqual([{ id: "t1", status: "active" }]);
    expect(usage).toHaveLength(1);
  });

  it("ships a usable noop logger and system clock", () => {
    expect(() => noopLogger.info("hi", { a: 1 })).not.toThrow();
    expect(typeof systemClock.now()).toBe("number");
  });
});
