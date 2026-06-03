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
  type NormalizedThreadRecord,
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
  it("an in-memory ThreadStore satisfies the expanded seam", async () => {
    const usage: NormalizedUsageRecord[] = [];
    const records = new Map<ThreadId, NormalizedThreadRecord>();
    const journals = new Map<ThreadId, unknown[]>();
    let prepared = 0;

    const store: ThreadStore = {
      async recordUsage(record) {
        usage.push(record);
      },
      async prepareThreadDir(name) {
        return { path: `/tmp/threads/${++prepared}-${name}` };
      },
      async discardPreparedThreadDir() {},
      async create(opts) {
        const now = new Date().toISOString();
        const record: NormalizedThreadRecord = {
          threadId: opts.threadId,
          name: opts.name,
          createdAt: now,
          modifiedAt: now,
          anchorId: opts.anchorId ?? null,
          anchorHistory: [],
          archived: false,
          pinned: false
        };
        records.set(opts.threadId, record);
        journals.set(opts.threadId, []);
        return record;
      },
      async list(opts) {
        return [...records.values()].filter((r) => {
          if (opts?.includeArchived !== true && r.archived) return false;
          if (opts?.anchorId !== undefined && r.anchorId !== opts.anchorId) return false;
          return true;
        });
      },
      async get(threadId) {
        return records.get(threadId) ?? null;
      },
      async update(threadId, patch) {
        const r = records.get(threadId);
        if (r === undefined) throw new Error(`unknown thread ${threadId}`);
        const next: NormalizedThreadRecord = {
          ...r,
          ...(patch.name !== undefined ? { name: patch.name } : {}),
          ...(patch.archived !== undefined ? { archived: patch.archived } : {}),
          ...(patch.pinned !== undefined ? { pinned: patch.pinned } : {}),
          modifiedAt: new Date().toISOString()
        };
        records.set(threadId, next);
        return next;
      },
      async delete(threadId) {
        records.delete(threadId);
        journals.delete(threadId);
      },
      async appendAnchor(threadId, anchorId) {
        const r = records.get(threadId);
        if (r === undefined) throw new Error(`unknown thread ${threadId}`);
        r.anchorId = anchorId;
        r.anchorHistory = [...r.anchorHistory, { anchorId, at: new Date().toISOString() }];
      },
      async journalAppend(threadId, entry) {
        const j = journals.get(threadId) ?? [];
        j.push(entry);
        journals.set(threadId, j);
      },
      async readJournal(threadId) {
        return [...(journals.get(threadId) ?? [])];
      },
      async attachmentsDir(threadId) {
        return `/tmp/threads/${threadId}/attachments`;
      }
    };

    const thread = createEmptyThread("t1");
    expect(thread).toEqual({ id: "t1", entries: [], messages: [], status: "active" });

    const prep = await store.prepareThreadDir("My Chat");
    const record = await store.create({ threadId: "t1", name: "My Chat", preparedDir: prep });
    expect(record.threadId).toBe("t1");
    expect(record.anchorId).toBeNull();

    await store.appendAnchor("t1", "cap-7");
    expect((await store.get("t1"))?.anchorId).toBe("cap-7");

    await store.journalAppend("t1", { kind: "message", message: { id: "m1" } });
    expect(await store.readJournal("t1")).toHaveLength(1);

    const archived = await store.update("t1", { archived: true });
    expect(archived.archived).toBe(true);
    expect(await store.list()).toHaveLength(0); // archived excluded by default
    expect(await store.list({ includeArchived: true })).toHaveLength(1);

    await store.recordUsage({
      threadId: "t1",
      turnId: "u1",
      usage: { totalTokens: 15, contextWindow: 200_000 },
      contextWindow: 200_000
    });
    expect(usage).toHaveLength(1);
    expect(usage[0]?.contextWindow).toBe(200_000);
  });

  it("ships a usable noop logger and system clock", () => {
    expect(() => noopLogger.info("hi", { a: 1 })).not.toThrow();
    expect(typeof systemClock.now()).toBe("number");
  });
});
