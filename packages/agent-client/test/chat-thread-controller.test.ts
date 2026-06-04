import { describe, it, expect, vi } from "vitest";
import { z } from "zod";
import type {
  AgentBackend,
  AgentBackendApprovalHandler,
  AgentBackendStartThreadResult,
  AgentBackendToolCall,
  AgentBackendToolCallHandler,
  AgentStartThreadOptions,
  AgentStartTurnOptions,
  NormalizedThreadEvent,
  NormalizedThreadRecord,
  NormalizedUsageRecord,
  ThreadStore
} from "@pwrdrvr/agent-core";
import type {
  DynamicToolCallParams,
  DynamicToolCallResponse
} from "@pwrdrvr/codex-app-server-protocol/v2";
import {
  ChatThreadController,
  type ChatBackend,
  type ChatControllerEvent
} from "../src/chat/chat-thread-controller";
import { defineTool, type ToolSpec } from "../src/chat/define-tool";
import { buildToolCatalog, dispatchToolCall } from "../src/chat/tool-catalog";

/** A fake AgentBackend: captures handlers, lets tests push events + drive the
 *  tool/approval ServerRequest paths, and mints deterministic thread/turn ids. */
class FakeBackend {
  eventCb: ((e: NormalizedThreadEvent) => void) | null = null;
  toolCb: AgentBackendToolCallHandler | null = null;
  approvalCb: AgentBackendApprovalHandler | null = null;
  /** Records the NEUTRAL turn options the controller passed (no Codex/ACP shape). */
  startTurn = vi.fn(async (_opts: AgentStartTurnOptions) => ({
    turnId: `turn-${++this.turnCounter}`
  }));
  interruptTurn = vi.fn(async (_threadId: string) => undefined);
  archiveThread = vi.fn(async (_threadId: string) => undefined);
  clearThreadGitInfo = vi.fn(async (_threadId: string) => undefined);
  close = vi.fn(async () => undefined);
  private threadCounter = 0;
  private turnCounter = 0;

  onEvent(cb: (e: NormalizedThreadEvent) => void): () => void {
    this.eventCb = cb;
    return () => undefined;
  }
  onToolCall(cb: AgentBackendToolCallHandler): () => void {
    this.toolCb = cb;
    return () => undefined;
  }
  onApprovalRequest(cb: AgentBackendApprovalHandler): () => void {
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
    const call: AgentBackendToolCall = { method: "item/dynamicTool/requestCall", params };
    return (await this.toolCb(call)) as DynamicToolCallResponse;
  }
  async requestApproval(method: string, params: unknown): Promise<string> {
    if (this.approvalCb === null) throw new Error("no approval handler");
    return this.approvalCb(method, params);
  }
}

/**
 * A neutral `AgentBackend` that RECORDS the options it receives. Two flavors:
 *   • Codex-like (`hasGitInfo=true`): returns model fields + supports
 *     clearThreadGitInfo.
 *   • ACP-like (`hasGitInfo=false`): mints `acp:`-prefixed ids, no model fields,
 *     omits the optional clearThreadGitInfo (the controller calls it via `?.`).
 * Both take the SAME neutral options — that's the point of the test.
 */
class RecordingBackend implements AgentBackend {
  startThreadOpts: AgentStartThreadOptions | undefined;
  startTurnOpts: AgentStartTurnOptions | undefined;
  lastThreadId = "";
  clearedGit = false;
  private counter = 0;
  // Codex-like instances expose clearThreadGitInfo; ACP-like ones omit it.
  clearThreadGitInfo?: (threadId: string) => Promise<void>;

  constructor(
    private readonly prefix: string,
    hasGitInfo: boolean
  ) {
    if (hasGitInfo) {
      this.clearThreadGitInfo = async (_threadId: string): Promise<void> => {
        this.clearedGit = true;
      };
    }
  }

  async startThread(options?: AgentStartThreadOptions): Promise<AgentBackendStartThreadResult> {
    this.startThreadOpts = options;
    this.lastThreadId = `${this.prefix}:thread-${++this.counter}`;
    const result: AgentBackendStartThreadResult = { threadId: this.lastThreadId };
    if (this.prefix === "codex") {
      result.model = "gpt-5-codex";
      result.modelProvider = "openai";
      result.serviceTier = "default";
    }
    return result;
  }
  async startTurn(options: AgentStartTurnOptions): Promise<{ turnId: string }> {
    this.startTurnOpts = options;
    return { turnId: `${this.prefix}:turn-1` };
  }
  async interruptTurn(): Promise<void> {}
  onEvent(): () => void {
    return () => undefined;
  }
  onToolCall(): () => void {
    return () => undefined;
  }
  onApprovalRequest(): () => void {
    return () => undefined;
  }
  async close(): Promise<void> {}
}

/** Full in-memory ThreadStore covering the expanded persistence surface. */
class MockStore implements ThreadStore {
  records = new Map<string, NormalizedThreadRecord>();
  journals = new Map<string, unknown[]>();
  usage: NormalizedUsageRecord[] = [];
  private prepared = 0;
  recordUsage = vi.fn(async (record: NormalizedUsageRecord) => {
    this.usage.push(record);
  });

  async prepareThreadDir(name: string): Promise<{ path: string }> {
    return { path: `/tmp/threads/${++this.prepared}-${name}` };
  }
  async discardPreparedThreadDir(): Promise<void> {}
  async create(opts: {
    threadId: string;
    name: string;
    anchorId?: string | null;
  }): Promise<NormalizedThreadRecord> {
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
    this.records.set(opts.threadId, record);
    this.journals.set(opts.threadId, []);
    return record;
  }
  async list(opts?: {
    includeArchived?: boolean;
    anchorId?: string | null;
  }): Promise<NormalizedThreadRecord[]> {
    return [...this.records.values()].filter((r) => {
      if (opts?.includeArchived !== true && r.archived) return false;
      if (opts?.anchorId !== undefined && r.anchorId !== opts.anchorId) return false;
      return true;
    });
  }
  async get(threadId: string): Promise<NormalizedThreadRecord | null> {
    return this.records.get(threadId) ?? null;
  }
  async update(
    threadId: string,
    patch: { name?: string; archived?: boolean; pinned?: boolean }
  ): Promise<NormalizedThreadRecord> {
    const r = this.records.get(threadId);
    if (r === undefined) throw new Error(`unknown thread ${threadId}`);
    const next: NormalizedThreadRecord = {
      ...r,
      ...(patch.name !== undefined ? { name: patch.name } : {}),
      ...(patch.archived !== undefined ? { archived: patch.archived } : {}),
      ...(patch.pinned !== undefined ? { pinned: patch.pinned } : {}),
      modifiedAt: new Date().toISOString()
    };
    this.records.set(threadId, next);
    return next;
  }
  async delete(threadId: string): Promise<void> {
    this.records.delete(threadId);
    this.journals.delete(threadId);
  }
  async appendAnchor(threadId: string, anchorId: string): Promise<void> {
    const r = this.records.get(threadId);
    if (r === undefined) throw new Error(`unknown thread ${threadId}`);
    r.anchorId = anchorId;
    r.anchorHistory = [...r.anchorHistory, { anchorId, at: new Date().toISOString() }];
  }
  async journalAppend(threadId: string, entry: unknown): Promise<void> {
    const j = this.journals.get(threadId) ?? [];
    j.push(entry);
    this.journals.set(threadId, j);
  }
  async readJournal(threadId: string): Promise<unknown[]> {
    return [...(this.journals.get(threadId) ?? [])];
  }
  async attachmentsDir(threadId: string): Promise<string> {
    return `/tmp/threads/${threadId}/attachments`;
  }
}

function makeController(
  over: Partial<ConstructorParameters<typeof ChatThreadController>[0]> = {}
): {
  controller: ChatThreadController;
  client: FakeBackend;
  store: MockStore;
  events: ChatControllerEvent[];
} {
  const client = new FakeBackend();
  const store = new MockStore();
  const events: ChatControllerEvent[] = [];
  let clock = 1_000;
  const controller = new ChatThreadController({
    client: client as unknown as ChatBackend,
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

    const deltas = events.filter((e) => e.type === "stream_delta");
    expect(deltas).toHaveLength(2);

    const history = await controller.getHistory(tid);
    const assistant = history.find((m) => m.role === "assistant");
    expect(assistant?.text).toBe("Hi there");
    const user = history.find((m) => m.role === "user");
    expect(user?.text).toBe("hello");
  });

  it("commits a failed assistant message carrying the reason on a terminal turn error", async () => {
    const { controller, client } = makeController();
    const view = await controller.createThread({ name: "T" });
    const tid = view.threadId;
    const { turnId } = await controller.sendMessage({ threadId: tid, text: "hi" });

    client.emit({ kind: "agent_message_delta", threadId: tid, turnId, itemId: "m", delta: "partial" });
    // willRetry:false — terminal: the controller ends the turn now, no turn_completed.
    client.emit({ kind: "error", threadId: tid, turnId, message: "rate limited", willRetry: false });
    await tick();

    const assistant = (await controller.getHistory(tid)).find((m) => m.role === "assistant");
    expect(assistant?.text).toContain("partial");
    expect(assistant?.text).toContain("rate limited");
  });

  it("keeps a retryable turn open and carries the reason to its eventual failure", async () => {
    const { controller, client } = makeController();
    const view = await controller.createThread({ name: "T" });
    const tid = view.threadId;
    const { turnId } = await controller.sendMessage({ threadId: tid, text: "hi" });

    client.emit({ kind: "error", threadId: tid, turnId, message: "transient", willRetry: true });
    await tick();
    expect((await controller.getHistory(tid)).find((m) => m.role === "assistant")).toBeUndefined();

    client.emit({ kind: "turn_completed", threadId: tid, turnId, status: "failed" });
    await tick();
    expect((await controller.getHistory(tid)).find((m) => m.role === "assistant")?.text).toContain(
      "transient"
    );
  });

  it("createThread persists an index row, prepares a dir, and broadcasts a view", async () => {
    const { controller, client, store, events } = makeController();
    const view = await controller.createThread({ name: "Design notes", anchorId: "cap-1" });

    expect(client.startThread).toHaveBeenCalledTimes(1);
    expect(client.clearThreadGitInfo).toHaveBeenCalledWith(view.threadId);
    expect(store.records.get(view.threadId)?.name).toBe("Design notes");
    expect(view.anchorId).toBe("cap-1");
    expect(view.status).toEqual({ kind: "idle" });

    const updated = events.find((e) => e.type === "thread_updated");
    expect(updated?.type).toBe("thread_updated");
  });

  it("discards the prepared dir when the backend fails to open the thread", async () => {
    const store = new MockStore();
    const discard = vi.spyOn(store, "discardPreparedThreadDir");
    const client = new FakeBackend();
    client.startThread.mockRejectedValueOnce(new Error("no codex"));
    const controller = new ChatThreadController({
      client: client as unknown as ChatBackend,
      store,
      readSettings: async () => ({}),
      broadcast: () => undefined,
      buildSystemPrompt: () => "SYSTEM"
    });
    controller.wire();

    await expect(controller.createThread({ name: "X" })).rejects.toThrow(/no codex/);
    expect(discard).toHaveBeenCalledTimes(1);
    expect(store.records.size).toBe(0);
  });

  it("lists threads with archived + anchor filters pushed to the store", async () => {
    const { controller } = makeController();
    const a = await controller.createThread({ name: "A", anchorId: "cap-1" });
    const b = await controller.createThread({ name: "B", anchorId: "cap-2" });
    await controller.createThread({ name: "C", anchorId: "cap-1" });

    const all = await controller.listThreads();
    expect(all).toHaveLength(3);

    const scoped = await controller.listThreads({ anchorId: "cap-1" });
    expect(scoped.map((t) => t.name).sort()).toEqual(["A", "C"]);

    await controller.archive(b.threadId, true);
    expect(await controller.listThreads()).toHaveLength(2);
    expect(await controller.listThreads({ includeArchived: true })).toHaveLength(3);
    expect(a.threadId).not.toBe(b.threadId);
  });

  it("renames a thread and broadcasts the updated view", async () => {
    const { controller, store, events } = makeController();
    const view = await controller.createThread({ name: "Old" });
    const renamed = await controller.rename(view.threadId, "  New name  ");
    expect(renamed.name).toBe("New name");
    expect(store.records.get(view.threadId)?.name).toBe("New name");
    const lastUpdate = [...events].reverse().find((e) => e.type === "thread_updated");
    expect(lastUpdate?.type === "thread_updated" && lastUpdate.thread.name).toBe("New name");
  });

  it("archives a thread on the store AND the backend", async () => {
    const { controller, client, store } = makeController();
    const view = await controller.createThread({ name: "Z" });
    const archived = await controller.archive(view.threadId, true);
    expect(archived.archived).toBe(true);
    expect(store.records.get(view.threadId)?.archived).toBe(true);
    expect(client.archiveThread).toHaveBeenCalledWith(view.threadId);
  });

  it("records usage through the injected ThreadStore, including contextWindow", async () => {
    const { controller, client, store } = makeController();
    const view = await controller.createThread();
    const { turnId } = await controller.sendMessage({ threadId: view.threadId, text: "x" });
    client.emit({
      kind: "token_usage",
      threadId: view.threadId,
      turnId,
      usage: { inputTokens: 7, outputTokens: 3, totalTokens: 10, contextWindow: 200_000 }
    });
    client.emit({ kind: "turn_completed", threadId: view.threadId, turnId, status: "completed" });
    await tick();

    expect(store.recordUsage).toHaveBeenCalledTimes(1);
    expect(store.usage[0]).toMatchObject({
      threadId: view.threadId,
      turnId,
      model: "gpt-5-codex",
      usage: { inputTokens: 7, outputTokens: 3, totalTokens: 10, contextWindow: 200_000 },
      contextWindow: 200_000
    });
  });

  it("snapshots settings at turn start (a mid-turn change can't retro-apply)", async () => {
    let guidance = "v1";
    const prompts: string[] = [];
    const { controller, client } = makeController({
      readSettings: async () => ({ guidance }),
      buildSystemPrompt: ({ settings }) => {
        const text = `prompt:${(settings as { guidance: string }).guidance}`;
        prompts.push(text);
        return text;
      }
    });
    const view = await controller.createThread();
    const { turnId } = await controller.sendMessage({ threadId: view.threadId, text: "go" });
    // A settings change mid-turn must not affect the in-flight turn.
    guidance = "v2";
    client.emit({ kind: "turn_completed", threadId: view.threadId, turnId, status: "completed" });
    await tick();
    // createThread built one prompt from v1; nothing re-read v2 into the live turn.
    expect(prompts).toEqual(["prompt:v1"]);
  });

  it("dispatches a tool call to the injected catalog and broadcasts a tool_call event", async () => {
    const echo = defineTool({
      namespace: "host_tools",
      name: "echo",
      description: "echo",
      argsSchema: z.object({ v: z.string() }),
      dispatch: async (args) => ({ ok: true, data: { echoed: args.v } })
    });
    const catalogTools = [echo as ToolSpec<unknown>];
    const { controller, client, events } = makeController({
      catalog: buildToolCatalog(catalogTools),
      dispatchToolCall: (params) => dispatchToolCall(params, catalogTools),
      toolLabels: { echo: "Echoing" }
    });
    const view = await controller.createThread();
    await controller.sendMessage({ threadId: view.threadId, text: "go" });

    const response = await client.callTool({
      threadId: view.threadId,
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

    const toolEvent = events.find((e) => e.type === "tool_call");
    expect(toolEvent?.type === "tool_call" && toolEvent.toolCall.label).toBe("Echoing");
    expect(toolEvent?.type === "tool_call" && toolEvent.toolCall.status).toBe("completed");
  });

  it("rejects an un-allowlisted tool through the dispatcher", async () => {
    const catalogTools: ToolSpec<unknown>[] = [];
    const { controller, client } = makeController({
      catalog: buildToolCatalog(catalogTools),
      dispatchToolCall: (params) => dispatchToolCall(params, catalogTools)
    });
    const view = await controller.createThread();
    await controller.sendMessage({ threadId: view.threadId, text: "go" });

    const response = await client.callTool({
      threadId: view.threadId,
      turnId: "turn-1",
      callId: "c1",
      namespace: "host_tools",
      tool: "danger",
      arguments: {} as never
    });
    expect(response.success).toBe(false);
    expect((response.contentItems[0] as { text: string }).text).toContain("Unknown tool: danger");
  });

  it("routes an approval by (threadId, turnId, approvalId) and rejects a stale resolution", async () => {
    const { controller, client, events } = makeController();
    const view = await controller.createThread();
    const tid = view.threadId;
    const { turnId } = await controller.sendMessage({ threadId: tid, text: "do it" });

    const decisionP = client.requestApproval("item/commandExecution/requestApproval", {
      threadId: tid,
      turnId,
      command: "rm -rf /"
    });
    await tick();

    const approvalEvent = events.find((e) => e.type === "approval_requested");
    expect(approvalEvent?.type).toBe("approval_requested");
    const approvalId =
      approvalEvent?.type === "approval_requested" ? approvalEvent.approval.id : "";
    expect(approvalId).not.toBe("");

    // A stale (wrong-id) resolution does not resolve the pending approval.
    await controller.resolveApproval({
      threadId: tid,
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
    await controller.resolveApproval({ threadId: tid, turnId, approvalId, decision: "approved" });
    await expect(decisionP).resolves.toBe("approved");
  });

  it("auto-denies an untagged approval when more than one turn is in flight", async () => {
    const { controller, client } = makeController();
    const a = await controller.createThread();
    const b = await controller.createThread();
    await controller.sendMessage({ threadId: a.threadId, text: "a" });
    await controller.sendMessage({ threadId: b.threadId, text: "b" });

    const decision = await client.requestApproval("tool/requestApproval", {});
    expect(decision).toBe("denied");
  });

  it("enforces the per-thread turn rate limit", async () => {
    const { controller, client } = makeController();
    const view = await controller.createThread();
    const tid = view.threadId;
    for (let i = 0; i < 5; i++) {
      const { turnId } = await controller.sendMessage({ threadId: tid, text: `m${i}` });
      client.emit({ kind: "turn_completed", threadId: tid, turnId, status: "completed" });
      await tick();
    }
    await expect(controller.sendMessage({ threadId: tid, text: "overflow" })).rejects.toThrow(
      /rate limit/
    );
  });

  it("passes NEUTRAL start/turn options the controller builds (no Codex/ACP shape)", async () => {
    const { controller, client } = makeController({
      catalog: [{ name: "echo" } as never],
      approvalPolicy: "never",
      sandbox: "read-only",
      serviceName: "svc",
      model: "m1",
      modelProvider: "p1",
      effort: "high",
      threadConfig: { foo: "bar" },
      threadEnvironments: [],
      buildSystemPrompt: () => "SYSTEM"
    });
    const view = await controller.createThread({ name: "T" });

    const startArg = client.startThread.mock.calls[0]?.[0] as AgentStartThreadOptions;
    // Neutral field names — instructions (not baseInstructions), workspaceRoots
    // (not runtimeWorkspaceRoots), tools (opaque, not dynamicTools).
    expect(view.threadId).toBeTruthy();
    expect(startArg).toMatchObject({
      instructions: "SYSTEM",
      cwd: expect.any(String),
      workspaceRoots: expect.arrayContaining([expect.any(String)]),
      approvalPolicy: "never",
      sandbox: "read-only",
      serviceName: "svc",
      model: "m1",
      modelProvider: "p1",
      config: { foo: "bar" },
      environments: [],
      tools: [{ name: "echo" }]
    });
    expect("baseInstructions" in startArg).toBe(false);
    expect("dynamicTools" in startArg).toBe(false);

    await controller.sendMessage({ threadId: view.threadId, text: "hello" });
    const turnArg = client.startTurn.mock.calls[0]?.[0] as AgentStartTurnOptions;
    expect(turnArg).toMatchObject({
      threadId: view.threadId,
      input: { text: "hello" },
      reasoning: "high"
    });
    expect("effort" in turnArg).toBe(false);
  });

  it("drives a fake Codex backend AND a fake ACP backend identically", async () => {
    // Two distinct backends with different native semantics (Codex returns model
    // fields + clears git info; ACP mints `acp:` ids and has neither). Both
    // implement the SAME non-generic AgentBackend and MUST receive byte-identical
    // NEUTRAL options from the controller — proving the controller never branches.
    const runOne = async (backend: RecordingBackend): Promise<void> => {
      const store = new MockStore();
      const controller = new ChatThreadController({
        client: backend,
        store,
        readSettings: async () => ({}),
        broadcast: () => undefined,
        buildSystemPrompt: () => "SYS",
        catalog: [{ name: "echo" } as never],
        approvalPolicy: "never",
        model: "m1",
        effort: "high"
      });
      controller.wire();
      const view = await controller.createThread({ name: "T" });
      await controller.sendMessage({ threadId: view.threadId, text: "hi" });
    };

    const codexLike = new RecordingBackend("codex", true);
    const acpLike = new RecordingBackend("acp", false);
    await runOne(codexLike);
    await runOne(acpLike);

    // Strip cwd/workspaceRoots (per-store temp paths differ) before comparing.
    const stripDirs = (o: AgentStartThreadOptions): AgentStartThreadOptions => {
      const { cwd: _cwd, workspaceRoots: _roots, ...rest } = o;
      return rest;
    };
    expect(stripDirs(codexLike.startThreadOpts!)).toEqual(stripDirs(acpLike.startThreadOpts!));
    expect(codexLike.startThreadOpts).toMatchObject({
      instructions: "SYS",
      approvalPolicy: "never",
      model: "m1",
      tools: [{ name: "echo" }]
    });
    // Both backends received the identical neutral turn options.
    expect(codexLike.startTurnOpts).toEqual({
      threadId: codexLike.lastThreadId,
      input: { text: "hi" },
      reasoning: "high"
    });
    expect(acpLike.startTurnOpts).toEqual({
      threadId: acpLike.lastThreadId,
      input: { text: "hi" },
      reasoning: "high"
    });
    // The controller drove ACP without knowing it lacks clearThreadGitInfo.
    expect(codexLike.clearedGit).toBe(true);
    expect(acpLike.clearedGit).toBe(false);
  });

  it("interrupting finalizes the assistant and broadcasts turn_interrupted", async () => {
    const { controller, client, events } = makeController();
    const view = await controller.createThread();
    const tid = view.threadId;
    const { turnId } = await controller.sendMessage({ threadId: tid, text: "long task" });
    client.emit({ kind: "agent_message_delta", threadId: tid, turnId, itemId: "m", delta: "partial" });
    await controller.interrupt(tid);

    expect(client.interruptTurn).toHaveBeenCalledWith(tid);
    const interrupted = events.find((e) => e.type === "turn_interrupted");
    expect(interrupted?.type === "turn_interrupted" && interrupted.turnId).toBe(turnId);
    const history = await controller.getHistory(tid);
    expect(history.find((m) => m.role === "assistant")?.text).toBe("partial");
  });
});
