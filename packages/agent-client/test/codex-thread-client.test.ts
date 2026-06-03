import { describe, it, expect } from "vitest";
import type { JsonRpcTransport } from "@pwrdrvr/agent-transport";
import type { NormalizedThreadEvent } from "@pwrdrvr/agent-core";
import { CodexThreadClient } from "../src/codex-thread-client";
import { CODEX_NOTIFICATION_METHODS } from "../src/normalize";

/**
 * In-memory JsonRpcTransport. Auto-answers requests it recognizes (initialize,
 * thread/start, thread/resume, turn/start, thread/archive, thread/metadata/update)
 * so a full lifecycle can run without a live Codex, and lets a test push scripted
 * inbound notifications.
 */
class FakeTransport implements JsonRpcTransport {
  sent: Array<{ method?: string; id?: unknown; params?: unknown }> = [];
  private messageHandler: (message: string) => void = () => undefined;
  private closeHandler: (error?: Error) => void = () => undefined;
  private threadCounter = 0;
  private turnCounter = 0;

  constructor(private readonly opts: { model?: string } = {}) {}

  async connect(): Promise<void> {}
  async close(): Promise<void> {
    this.closeHandler();
  }
  setMessageHandler(handler: (message: string) => void): void {
    this.messageHandler = handler;
  }
  setCloseHandler(handler: (error?: Error) => void): void {
    this.closeHandler = handler;
  }

  send(message: string): void {
    const env = JSON.parse(message) as { method?: string; id?: unknown; params?: unknown };
    this.sent.push(env);
    if (env.id === undefined || env.method === undefined) return;
    const result = this.respond(env.method);
    queueMicrotask(() => {
      this.messageHandler(JSON.stringify({ jsonrpc: "2.0", id: env.id, result }));
    });
  }

  private respond(method: string): unknown {
    switch (method) {
      case "initialize":
        return { userAgent: "fake/1.0", capabilities: {} };
      case "thread/start": {
        const id = `thread-${++this.threadCounter}`;
        return {
          thread: { id },
          model: this.opts.model ?? "gpt-5-codex",
          modelProvider: "openai",
          serviceTier: "default"
        };
      }
      case "thread/resume":
        return { thread: { id: "thread-resumed" } };
      case "turn/start":
        return { turn: { id: `turn-${++this.turnCounter}` } };
      default:
        return {};
    }
  }

  // test helper: push an inbound notification
  notify(method: string, params: unknown): void {
    this.messageHandler(JSON.stringify({ jsonrpc: "2.0", method, params }));
  }

  sentMethods(): string[] {
    return this.sent.filter((e) => e.method !== undefined).map((e) => e.method as string);
  }

  initializeParams(): Record<string, unknown> | undefined {
    const init = this.sent.find((e) => e.method === "initialize");
    return init?.params as Record<string, unknown> | undefined;
  }
}

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

describe("CodexThreadClient", () => {
  it("drives a full lifecycle and emits normalized events", async () => {
    const fake = new FakeTransport();
    const client = new CodexThreadClient({ transportFactory: () => fake });
    const events: NormalizedThreadEvent[] = [];
    client.onEvent((e) => events.push(e));

    const started = await client.startThread({ baseInstructions: "be terse" });
    expect(started.threadId).toBe("thread-1");
    expect(started.model).toBe("gpt-5-codex");

    const { turnId } = await client.startTurn({
      threadId: started.threadId,
      input: [{ type: "text", text: "hi", text_elements: [] }]
    });
    expect(turnId).toBe("turn-1");

    // Scripted inbound notifications for the turn.
    fake.notify(CODEX_NOTIFICATION_METHODS.turnStarted, {
      threadId: started.threadId,
      turn: { id: turnId, items: [], itemsView: "full", status: "inProgress", error: null }
    });
    fake.notify(CODEX_NOTIFICATION_METHODS.agentMessageDelta, {
      threadId: started.threadId,
      turnId,
      itemId: "m1",
      delta: "yo"
    });
    fake.notify(CODEX_NOTIFICATION_METHODS.turnCompleted, {
      threadId: started.threadId,
      turn: { id: turnId, items: [], itemsView: "full", status: "completed", error: null }
    });
    await tick();

    await client.archiveThread(started.threadId);
    await client.close();

    expect(events).toEqual([
      { kind: "turn_started", threadId: "thread-1", turnId: "turn-1" },
      { kind: "agent_message_delta", threadId: "thread-1", turnId: "turn-1", itemId: "m1", delta: "yo" },
      { kind: "turn_completed", threadId: "thread-1", turnId: "turn-1", status: "completed" }
    ]);

    expect(fake.sentMethods()).toContain("initialize");
    expect(fake.sentMethods()).toContain("thread/start");
    expect(fake.sentMethods()).toContain("turn/start");
    expect(fake.sentMethods()).toContain("thread/archive");
  });

  it("sends a configurable clientInfo.name at initialize", async () => {
    const fake = new FakeTransport();
    const client = new CodexThreadClient({
      transportFactory: () => fake,
      clientName: "my-host",
      clientTitle: "My Host",
      clientVersion: "9.9.9"
    });
    await client.startThread();
    const params = fake.initializeParams();
    expect((params?.clientInfo as Record<string, unknown>).name).toBe("my-host");
    expect((params?.clientInfo as Record<string, unknown>).title).toBe("My Host");
    expect((params?.clientInfo as Record<string, unknown>).version).toBe("9.9.9");
  });

  it("defaults clientInfo.name to a neutral identity (not pwrsnap)", async () => {
    const fake = new FakeTransport();
    const client = new CodexThreadClient({ transportFactory: () => fake });
    await client.startThread();
    const params = fake.initializeParams();
    expect((params?.clientInfo as Record<string, unknown>).name).toBe("agent-kit");
  });

  it("keeps two concurrent threads' streams independent", async () => {
    const fake = new FakeTransport();
    const client = new CodexThreadClient({ transportFactory: () => fake });
    const byThread = new Map<string, string>();
    client.onEvent((e) => {
      if (e.kind === "agent_message_delta") {
        byThread.set(e.threadId, (byThread.get(e.threadId) ?? "") + e.delta);
      }
    });

    const a = await client.startThread();
    const b = await client.startThread();
    expect(a.threadId).not.toBe(b.threadId);

    const ta = await client.startTurn({
      threadId: a.threadId,
      input: [{ type: "text", text: "a", text_elements: [] }]
    });
    const tb = await client.startTurn({
      threadId: b.threadId,
      input: [{ type: "text", text: "b", text_elements: [] }]
    });

    fake.notify(CODEX_NOTIFICATION_METHODS.agentMessageDelta, {
      threadId: a.threadId,
      turnId: ta.turnId,
      itemId: "m",
      delta: "AAA"
    });
    fake.notify(CODEX_NOTIFICATION_METHODS.agentMessageDelta, {
      threadId: b.threadId,
      turnId: tb.turnId,
      itemId: "m",
      delta: "BBB"
    });
    await tick();

    expect(byThread.get(a.threadId)).toBe("AAA");
    expect(byThread.get(b.threadId)).toBe("BBB");
  });
});
