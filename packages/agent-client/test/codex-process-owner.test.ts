import { describe, it, expect } from "vitest";
import type { JsonRpcTransport } from "@pwrdrvr/agent-transport";
import type {
  NormalizedApprovalDecision,
  NormalizedThreadEvent
} from "@pwrdrvr/agent-core";
import { CodexProcessOwner } from "../src/codex-process-owner";
import { CodexProcessOwnerPool } from "../src/codex-process-owner-pool";
import { CODEX_NOTIFICATION_METHODS } from "../src/normalize";

/**
 * In-memory JsonRpcTransport that auto-answers the requests an owner makes and
 * lets a test (a) push inbound notifications and (b) inject server-requests
 * (tool-call / approval) from "Codex" and read back the client's response.
 */
class FakeTransport implements JsonRpcTransport {
  sent: Array<{ method?: string; id?: unknown; params?: unknown; result?: unknown }> = [];
  private messageHandler: (message: string) => void = () => undefined;
  private closeHandler: (error?: Error) => void = () => undefined;
  private threadCounter = 0;
  private turnCounter = 0;
  private serverReqId = 0;
  private readonly pendingServerReqs = new Map<number, (result: unknown) => void>();
  lastThreadId = "";
  lastTurnId = "";
  closed = false;

  async connect(): Promise<void> {}
  async close(): Promise<void> {
    this.closed = true;
    this.closeHandler();
  }
  setMessageHandler(handler: (message: string) => void): void {
    this.messageHandler = handler;
  }
  setCloseHandler(handler: (error?: Error) => void): void {
    this.closeHandler = handler;
  }

  send(message: string): void {
    const env = JSON.parse(message) as {
      method?: string;
      id?: unknown;
      params?: unknown;
      result?: unknown;
    };
    this.sent.push(env);
    // A client→server REQUEST (has both id and method): auto-respond.
    if (env.id !== undefined && env.method !== undefined) {
      const result = this.respond(env.method, env.params);
      queueMicrotask(() => {
        this.messageHandler(JSON.stringify({ jsonrpc: "2.0", id: env.id, result }));
      });
      return;
    }
    // The client's RESPONSE to a server-initiated request (id, no method).
    if (env.id !== undefined && env.method === undefined) {
      const resolve = this.pendingServerReqs.get(env.id as number);
      if (resolve) {
        this.pendingServerReqs.delete(env.id as number);
        resolve(env.result);
      }
    }
  }

  private respond(method: string, _params: unknown): unknown {
    switch (method) {
      case "initialize":
        return { userAgent: "fake/1.0", capabilities: {} };
      case "thread/start": {
        this.lastThreadId = `thread-${++this.threadCounter}`;
        return {
          thread: { id: this.lastThreadId },
          model: "gpt-5-codex",
          modelProvider: "openai",
          serviceTier: "default"
        };
      }
      case "thread/resume":
        return { thread: { id: "thread-resumed" } };
      case "turn/start": {
        this.lastTurnId = `turn-${++this.turnCounter}`;
        return { turn: { id: this.lastTurnId } };
      }
      case "model/list":
        return {
          data: [
            {
              id: "gpt-5-codex",
              model: "gpt-5-codex",
              displayName: "GPT-5 Codex",
              description: "",
              hidden: false,
              inputModalities: ["text"],
              defaultServiceTier: null,
              isDefault: true
            }
          ],
          nextCursor: null
        };
      default:
        return {};
    }
  }

  notify(method: string, params: unknown): void {
    this.messageHandler(JSON.stringify({ jsonrpc: "2.0", method, params }));
  }

  /** Inject a server-initiated request and resolve with the client's response. */
  serverRequest(method: string, params: unknown): Promise<unknown> {
    const id = `srv-${++this.serverReqId}`;
    return new Promise<unknown>((resolve) => {
      this.pendingServerReqs.set(id as unknown as number, resolve);
      this.messageHandler(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
    });
  }

  sentMethods(): string[] {
    return this.sent.filter((e) => e.method !== undefined).map((e) => e.method as string);
  }

  async waitForSent(method: string): Promise<void> {
    for (let i = 0; i < 50; i++) {
      if (this.sentMethods().includes(method)) return;
      await tick();
    }
    throw new Error(`timed out waiting for ${method} to be sent`);
  }
}

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

describe("CodexProcessOwner — per-view routing", () => {
  it("routes a thread's events only to the view that owns it", async () => {
    const fake = new FakeTransport();
    const owner = new CodexProcessOwner({ transportFactory: () => fake });
    const viewA = owner.createBackendView();
    const viewB = owner.createBackendView();
    const a: NormalizedThreadEvent[] = [];
    const b: NormalizedThreadEvent[] = [];
    viewA.onEvent((e) => a.push(e));
    viewB.onEvent((e) => b.push(e));

    const ta = await viewA.startThread();
    const tb = await viewB.startThread();
    expect(ta.threadId).not.toBe(tb.threadId);

    fake.notify(CODEX_NOTIFICATION_METHODS.agentMessageDelta, {
      threadId: ta.threadId,
      turnId: "t1",
      itemId: "m",
      delta: "AAA"
    });
    fake.notify(CODEX_NOTIFICATION_METHODS.agentMessageDelta, {
      threadId: tb.threadId,
      turnId: "t2",
      itemId: "m",
      delta: "BBB"
    });
    await tick();

    expect(a).toEqual([
      { kind: "agent_message_delta", threadId: ta.threadId, turnId: "t1", itemId: "m", delta: "AAA" }
    ]);
    expect(b).toEqual([
      { kind: "agent_message_delta", threadId: tb.threadId, turnId: "t2", itemId: "m", delta: "BBB" }
    ]);
    await owner.close();
  });

  it("routes a tool call to the owning view's handler, not a sibling's", async () => {
    const fake = new FakeTransport();
    const owner = new CodexProcessOwner({ transportFactory: () => fake });
    const viewA = owner.createBackendView();
    const viewB = owner.createBackendView();
    const calledOn: string[] = [];
    viewA.onToolCall(async () => {
      calledOn.push("A");
      return { contentItems: [{ type: "inputText", text: "from A" }], success: true };
    });
    viewB.onToolCall(async () => {
      calledOn.push("B");
      return { contentItems: [{ type: "inputText", text: "from B" }], success: true };
    });

    const ta = await viewA.startThread();
    await viewB.startThread();

    const response = (await fake.serverRequest("item/tool/call", {
      threadId: ta.threadId,
      turnId: "t1",
      callId: "c1",
      namespace: null,
      tool: "echo",
      arguments: {}
    })) as { success: boolean };

    expect(calledOn).toEqual(["A"]);
    expect(response.success).toBe(true);
    await owner.close();
  });

  it("routes an approval to the owning view and maps the neutral decision", async () => {
    const fake = new FakeTransport();
    const owner = new CodexProcessOwner({ transportFactory: () => fake });
    const view = owner.createBackendView();
    let seenMethod = "";
    view.onApprovalRequest(async (method): Promise<NormalizedApprovalDecision> => {
      seenMethod = method;
      return "approved";
    });
    const t = await view.startThread();

    const decision = (await fake.serverRequest("item/commandExecution/requestApproval", {
      threadId: t.threadId,
      turnId: "t1",
      itemId: "i1"
    })) as { decision: string };

    expect(seenMethod).toBe("item/commandExecution/requestApproval");
    expect(decision.decision).toBe("approved");
    await owner.close();
  });

  it("denies a tool call / approval for a thread with no registered handler", async () => {
    const fake = new FakeTransport();
    const owner = new CodexProcessOwner({ transportFactory: () => fake });
    const view = owner.createBackendView();
    const t = await view.startThread(); // no onToolCall/onApprovalRequest registered

    const tool = (await fake.serverRequest("item/tool/call", {
      threadId: t.threadId,
      turnId: "x",
      callId: "c",
      namespace: null,
      tool: "echo",
      arguments: {}
    })) as { success: boolean };
    expect(tool.success).toBe(false);

    const appr = (await fake.serverRequest("item/fileChange/requestApproval", {
      threadId: t.threadId,
      turnId: "x",
      itemId: "i"
    })) as { decision: string };
    expect(appr.decision).toBe("denied");
    await owner.close();
  });

  it("detaching a view stops routing its threads without killing the process", async () => {
    const fake = new FakeTransport();
    const owner = new CodexProcessOwner({ transportFactory: () => fake });
    const viewA = owner.createBackendView();
    const viewB = owner.createBackendView();
    const a: NormalizedThreadEvent[] = [];
    viewA.onEvent((e) => a.push(e));
    const ta = await viewA.startThread();
    const tb = await viewB.startThread();

    await viewA.close(); // detach A — process stays up for B

    fake.notify(CODEX_NOTIFICATION_METHODS.agentMessageDelta, {
      threadId: ta.threadId,
      turnId: "t",
      itemId: "m",
      delta: "late"
    });
    await tick();
    expect(a).toEqual([]); // A no longer receives its thread's events
    expect(fake.closed).toBe(false); // process not torn down

    // B still works on the same process.
    const turn = await viewB.startTurn({ threadId: tb.threadId, input: { text: "hi" } });
    expect(turn.turnId).toBeTruthy();
    await owner.close();
    expect(fake.closed).toBe(true);
  });
});

describe("CodexProcessOwner — model listing + one-shot over the shared connection", () => {
  it("lists models without opening a thread", async () => {
    const fake = new FakeTransport();
    const owner = new CodexProcessOwner({ transportFactory: () => fake });
    const models = await owner.listModels();
    expect(models.map((m) => m.id)).toEqual(["gpt-5-codex"]);
    expect(fake.sentMethods()).toContain("model/list");
    expect(fake.sentMethods()).not.toContain("thread/start");
    await owner.close();
  });

  it("runs a structured one-shot turn (outputSchema + rollback) without leaking to a view", async () => {
    const fake = new FakeTransport();
    const owner = new CodexProcessOwner({ transportFactory: () => fake });
    const view = owner.createBackendView();
    const viewEvents: NormalizedThreadEvent[] = [];
    view.onEvent((e) => viewEvents.push(e));

    const schema = { type: "object", properties: { ok: { type: "boolean" } } };
    const pending = owner.runOneShot({ prompt: "enrich this", outputSchema: schema });

    // Let the worker thread + turn get established, then drive completion.
    await fake.waitForSent("turn/start");
    const workerThreadId = fake.lastThreadId;
    const turnId = fake.lastTurnId;
    fake.notify("item/completed", {
      threadId: workerThreadId,
      turnId,
      item: { type: "agentMessage", text: '{"ok":true}' }
    });
    fake.notify("thread/tokenUsage/updated", {
      threadId: workerThreadId,
      turnId,
      tokenUsage: {
        last: {
          inputTokens: 10,
          cachedInputTokens: 0,
          outputTokens: 5,
          reasoningOutputTokens: 0,
          totalTokens: 15
        },
        modelContextWindow: 200000
      }
    });
    fake.notify("turn/completed", {
      threadId: workerThreadId,
      turn: { id: turnId, items: [], itemsView: "full", status: "completed", error: null }
    });

    const res = await pending;
    expect(res.rawText).toBe('{"ok":true}');
    expect(res.tokenUsage?.totalTokens).toBe(15);

    // outputSchema rode the turn, and the turn was rolled back afterward.
    const turnStart = fake.sent.find((e) => e.method === "turn/start")?.params as Record<
      string,
      unknown
    >;
    expect(turnStart.outputSchema).toEqual(schema);
    expect(fake.sentMethods()).toContain("thread/rollback");

    // The worker thread's stream never reached the surface view.
    expect(viewEvents).toEqual([]);
    await owner.close();
    expect(fake.sentMethods()).toContain("thread/archive"); // worker archived on close
  });
});

describe("CodexProcessOwnerPool", () => {
  it("hands the same warmed owner to concurrent acquires for a key", async () => {
    const pool = new CodexProcessOwnerPool();
    let built = 0;
    const factory = (): CodexProcessOwner => {
      built++;
      return new CodexProcessOwner({ transportFactory: () => new FakeTransport() });
    };
    const [a, b] = await Promise.all([
      pool.acquire("codex::default", factory),
      pool.acquire("codex::default", factory)
    ]);
    expect(a).toBe(b);
    expect(built).toBe(1);
    expect(pool.has("codex::default")).toBe(true);
    await pool.closeAll();
    expect(pool.has("codex::default")).toBe(false);
  });

  it("keys distinct identities to distinct owners and releases one", async () => {
    const pool = new CodexProcessOwnerPool();
    const factory = (): CodexProcessOwner =>
      new CodexProcessOwner({ transportFactory: () => new FakeTransport() });
    const one = await pool.acquire("codex::home-a", factory);
    const two = await pool.acquire("codex::home-b", factory);
    expect(one).not.toBe(two);

    await pool.release("codex::home-a");
    expect(pool.has("codex::home-a")).toBe(false);
    expect(pool.has("codex::home-b")).toBe(true);
    await pool.release("codex::missing"); // safe no-op
    await pool.closeAll();
  });
});
