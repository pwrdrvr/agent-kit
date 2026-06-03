import { describe, it, expect, vi } from "vitest";
import { z } from "zod";
import type {
  NormalizedThread,
  NormalizedThreadEvent,
  NormalizedThreadSummary,
  NormalizedUsageRecord,
  ThreadStore
} from "@pwrdrvr/agent-core";
import type {
  DynamicToolCallParams,
  DynamicToolCallResponse
} from "@pwrdrvr/codex-app-server-protocol/v2";
import { ChatThreadController } from "../src/chat/chat-thread-controller";
import type {
  CodexThreadClient,
  CodexToolCallHandler,
  CodexApprovalHandler
} from "../src/codex-thread-client";
import { defineTool, type ToolSpec } from "../src/chat/define-tool";
import { buildToolCatalog, dispatchToolCall } from "../src/chat/tool-catalog";

/** A fake CodexThreadClient: captures handlers, lets tests push events + drive
 *  the tool/approval ServerRequest paths, and mints deterministic thread/turn ids. */
class FakeClient {
  eventCb: ((e: NormalizedThreadEvent) => void) | null = null;
  toolCb: CodexToolCallHandler | null = null;
  approvalCb: CodexApprovalHandler | null = null;
  startTurn = vi.fn(async (_opts: { threadId: string; input: unknown[]; effort?: string }) => ({
    turnId: `turn-${++this.turnCounter}`
  }));
  interruptTurn = vi.fn(async (_threadId: string) => undefined);
  archiveThread = vi.fn(async (_threadId: string) => undefined);
  clearThreadGitInfo = vi.fn(async (_threadId: string) => undefined);
  private threadCounter = 0;
  private turnCounter = 0;

  onEvent(cb: (e: NormalizedThreadEvent) => void): () => void {
    this.eventCb = cb;
    return () => undefined;
  }
  onToolCall(cb: CodexToolCallHandler): () => void {
    this.toolCb = cb;
    return () => undefined;
  }
  onApprovalRequest(cb: CodexApprovalHandler): () => void {
    this.approvalCb = cb;
    return () => undefined;
  }
  startThread = vi.fn(async (_opts?: unknown) => ({
    threadId: `thread-${++this.threadCounter}`,
    model: "gpt-5-codex",
    modelProvider: "openai",
    serviceTier: "default" as string | null
  }));

  emit(e: NormalizedThreadEvent): void {
    this.eventCb?.(e);
  }
  async callTool(params: DynamicToolCallParams): Promise<DynamicToolCallResponse> {
    if (this.toolCb === null) throw new Error("no tool handler");
    return this.toolCb(params);
  }
  async requestApproval(method: string, params: unknown): Promise<string> {
    if (this.approvalCb === null) throw new Error("no approval handler");
    return this.approvalCb(method, params);
  }
}

class MockStore implements ThreadStore {
  threads = new Map<string, NormalizedThread>();
  usage: NormalizedUsageRecord[] = [];
  recordUsage = vi.fn(async (record: NormalizedUsageRecord) => {
    this.usage.push(record);
  });
  async saveThread(thread: NormalizedThread): Promise<void> {
    this.threads.set(thread.id, thread);
  }
  async loadThread(id: string): Promise<NormalizedThread | null> {
    return this.threads.get(id) ?? null;
  }
  async listThreads(): Promise<NormalizedThreadSummary[]> {
    return [...this.threads.values()].map((t) => ({ id: t.id }));
  }
}

function makeController(
  over: Partial<ConstructorParameters<typeof ChatThreadController>[0]> = {}
): { controller: ChatThreadController; client: FakeClient; store: MockStore; events: NormalizedThreadEvent[] } {
  const client = new FakeClient();
  const store = new MockStore();
  const events: NormalizedThreadEvent[] = [];
  let clock = 1_000;
  const controller = new ChatThreadController({
    client: client as unknown as CodexThreadClient,
    store,
    readSettings: async () => ({ guidance: "be nice" }),
    broadcast: (e) => events.push(e),
    buildSystemPrompt: () => "SYSTEM",
    now: () => (clock += 1),
    ...over
  });
  controller.wire();
  return { controller, client, store, events };
}

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

describe("ChatThreadController", () => {
  it("streams deltas and commits the assistant message on turn_completed", async () => {
    const { controller, client, store, events } = makeController();
    const view = await controller.createThread({ name: "T" });
    const tid = view.threadId;

    const { turnId } = await controller.sendMessage({ threadId: tid, text: "hello" });

    client.emit({ kind: "agent_message_delta", threadId: tid, turnId, itemId: "m", delta: "Hi " });
    client.emit({ kind: "agent_message_delta", threadId: tid, turnId, itemId: "m", delta: "there" });
    client.emit({
      kind: "token_usage",
      threadId: tid,
      turnId,
      usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 }
    });
    client.emit({ kind: "turn_completed", threadId: tid, turnId, status: "completed" });
    await tick();

    const deltas = events.filter((e) => e.kind === "agent_message_delta");
    expect(deltas).toHaveLength(2);

    const history = await controller.getHistory(tid);
    const assistant = history.find((m) => m.role === "assistant");
    expect(assistant?.text).toBe("Hi there");

    // Persisted thread holds the committed transcript.
    const saved = store.threads.get(tid);
    expect(saved?.lastAssistantMessage).toBe("Hi there");
    expect(saved?.lastUserMessage).toBe("hello");
  });

  it("records usage through the injected ThreadStore (not a hardcoded call)", async () => {
    const { controller, client, store } = makeController();
    const { threadId } = await controller.createThread();
    const { turnId } = await controller.sendMessage({ threadId, text: "x" });
    client.emit({
      kind: "token_usage",
      threadId,
      turnId,
      usage: { inputTokens: 7, outputTokens: 3, totalTokens: 10 }
    });
    client.emit({ kind: "turn_completed", threadId, turnId, status: "completed" });
    await tick();

    expect(store.recordUsage).toHaveBeenCalledTimes(1);
    expect(store.usage[0]).toMatchObject({
      threadId,
      turnId,
      model: "gpt-5-codex",
      usage: { inputTokens: 7, outputTokens: 3, totalTokens: 10 }
    });
  });

  it("dispatches a tool call to the injected catalog and returns it to the turn", async () => {
    const echo = defineTool({
      namespace: "host_tools",
      name: "echo",
      description: "echo",
      argsSchema: z.object({ v: z.string() }),
      dispatch: async (args) => ({ ok: true, data: { echoed: args.v } })
    });
    const catalogTools = [echo as ToolSpec<unknown>];
    const { controller, client } = makeController({
      catalog: buildToolCatalog(catalogTools),
      dispatchToolCall: (params) => dispatchToolCall(params, catalogTools)
    });
    const { threadId } = await controller.createThread();
    await controller.sendMessage({ threadId, text: "go" });

    const response = await client.callTool({
      threadId,
      turnId: "turn-1",
      callId: "c1",
      namespace: "host_tools",
      tool: "echo",
      arguments: { v: "hi" } as never
    });
    expect(response.success).toBe(true);
    expect(response.contentItems[0]).toEqual({
      type: "inputText",
      text: JSON.stringify({ echoed: "hi" })
    });
  });

  it("rejects an un-allowlisted tool through the dispatcher", async () => {
    const catalogTools: ToolSpec<unknown>[] = [];
    const { controller, client } = makeController({
      catalog: buildToolCatalog(catalogTools),
      dispatchToolCall: (params) => dispatchToolCall(params, catalogTools)
    });
    const { threadId } = await controller.createThread();
    await controller.sendMessage({ threadId, text: "go" });

    const response = await client.callTool({
      threadId,
      turnId: "turn-1",
      callId: "c1",
      namespace: "host_tools",
      tool: "danger",
      arguments: {} as never
    });
    expect(response.success).toBe(false);
    expect((response.contentItems[0] as { text: string }).text).toContain("Unknown tool: danger");
  });

  it("routes an approval by (threadId, turnId, approvalId)", async () => {
    const { controller, client, events } = makeController();
    const { threadId } = await controller.createThread();
    const { turnId } = await controller.sendMessage({ threadId, text: "do it" });

    const decisionP = client.requestApproval("item/commandExecution/requestApproval", {
      threadId,
      turnId,
      command: "rm -rf /"
    });
    await tick();

    const approvalEvent = events.find((e) => e.kind === "approval_request");
    expect(approvalEvent?.kind).toBe("approval_request");
    const approvalId =
      approvalEvent?.kind === "approval_request" ? approvalEvent.approval.id : "";
    expect(approvalId).not.toBe("");

    // A stale (wrong-id) resolution does not resolve the pending approval.
    await controller.resolveApproval({
      threadId,
      turnId,
      approvalId: "wrong-id",
      decision: "approved"
    });
    const settledEarly = await Promise.race([
      decisionP.then(() => "settled"),
      tick().then(() => "pending")
    ]);
    expect(settledEarly).toBe("pending");

    // The correctly-keyed resolution resolves it.
    await controller.resolveApproval({ threadId, turnId, approvalId, decision: "approved" });
    await expect(decisionP).resolves.toBe("approved");
  });

  it("enforces the per-thread turn rate limit", async () => {
    const { controller, client } = makeController();
    const { threadId } = await controller.createThread();
    for (let i = 0; i < 5; i++) {
      const { turnId } = await controller.sendMessage({ threadId, text: `m${i}` });
      // Finalize each turn so the next sendMessage isn't blocked by an in-flight turn.
      client.emit({ kind: "turn_completed", threadId, turnId, status: "completed" });
      await tick();
    }
    await expect(controller.sendMessage({ threadId, text: "overflow" })).rejects.toThrow(
      /rate limit/
    );
  });
});
