import { describe, it, expect } from "vitest";
import type { JsonRpcTransport } from "@pwrdrvr/agent-transport";
import { CodexThreadClient } from "../src/codex-thread-client";

/**
 * Fake transport answering the feature wire methods (turn/steer,
 * thread/compact/start, review/start, config/value/write) on top of the
 * lifecycle basics, so the ported native methods can be driven without a live
 * Codex. Each feature response carries the id shapes the extractors read.
 */
class FeatureFakeTransport implements JsonRpcTransport {
  sent: Array<{ method?: string; id?: unknown; params?: unknown }> = [];
  private messageHandler: (message: string) => void = () => undefined;
  private closeHandler: (error?: Error) => void = () => undefined;

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
      case "thread/start":
        return {
          thread: { id: "thread-1" },
          model: "gpt-5-codex",
          modelProvider: "openai",
          serviceTier: "default"
        };
      case "thread/resume":
        return { thread: { id: "thread-1" } };
      case "turn/start":
        return { turn: { id: "turn-1" } };
      case "turn/steer":
        return { turn: { id: "turn-7" } };
      case "thread/compact/start":
        return { threadId: "thread-1", turn: { id: "turn-compact" }, itemId: "item-9" };
      case "review/start":
        return { reviewThreadId: "review-thread-2", turn: { id: "turn-review" } };
      case "config/value/write":
        return {};
      default:
        return {};
    }
  }

  paramsFor(method: string): Record<string, unknown> | undefined {
    return this.sent.find((e) => e.method === method)?.params as
      | Record<string, unknown>
      | undefined;
  }
}

describe("CodexThreadClient — ported features", () => {
  it("steerTurn sends turn/steer with the precondition and resolves the active turn", async () => {
    const fake = new FeatureFakeTransport();
    const client = new CodexThreadClient({ transportFactory: () => fake });
    await client.startThread();

    const result = await client.steerTurn({
      threadId: "thread-1",
      input: [{ type: "text", text: "actually, focus on tests", text_elements: [] }],
      expectedTurnId: "turn-1"
    });

    expect(result).toEqual({ threadId: "thread-1", turnId: "turn-7" });
    const params = fake.paramsFor("turn/steer");
    expect(params?.threadId).toBe("thread-1");
    expect(params?.expectedTurnId).toBe("turn-1");
    expect(params?.input).toEqual([
      { type: "text", text: "actually, focus on tests", text_elements: [] }
    ]);
    await client.close();
  });

  it("steerTurn falls back to expectedTurnId when the response omits a turn id", async () => {
    const fake = new FeatureFakeTransport();
    // Override: respond to turn/steer with no id.
    (fake as unknown as { respond: (m: string) => unknown }).respond = (m: string) =>
      m === "initialize"
        ? { capabilities: {} }
        : m === "thread/start"
          ? { thread: { id: "thread-1" }, model: "m", modelProvider: "p", serviceTier: null }
          : {};
    const client = new CodexThreadClient({ transportFactory: () => fake });
    await client.startThread();
    const result = await client.steerTurn({
      threadId: "thread-1",
      input: [],
      expectedTurnId: "turn-42"
    });
    expect(result.turnId).toBe("turn-42");
    await client.close();
  });

  it("compactThread sends thread/compact/start and extracts turn + item ids", async () => {
    const fake = new FeatureFakeTransport();
    const client = new CodexThreadClient({ transportFactory: () => fake });
    await client.startThread();

    const result = await client.compactThread("thread-1");
    expect(result).toEqual({
      threadId: "thread-1",
      turnId: "turn-compact",
      itemId: "item-9"
    });
    expect(fake.paramsFor("thread/compact/start")?.threadId).toBe("thread-1");
    await client.close();
  });

  it("startReview sends review/start and extracts the review thread + turn", async () => {
    const fake = new FeatureFakeTransport();
    const client = new CodexThreadClient({ transportFactory: () => fake });
    await client.startThread();

    const result = await client.startReview({
      threadId: "thread-1",
      target: { type: "uncommittedChanges" } as never
    });
    expect(result).toEqual({
      threadId: "thread-1",
      reviewThreadId: "review-thread-2",
      turnId: "turn-review"
    });
    const params = fake.paramsFor("review/start");
    expect(params?.threadId).toBe("thread-1");
    expect(params?.delivery).toBe("inline");
    await client.close();
  });

  it("trustProject writes the projects config overlay", async () => {
    const fake = new FeatureFakeTransport();
    const client = new CodexThreadClient({ transportFactory: () => fake });
    await client.startThread();

    const result = await client.trustProject({ projectPath: "/work/repo" });
    expect(result).toEqual({ projectPath: "/work/repo" });
    const params = fake.paramsFor("config/value/write");
    expect(params?.keyPath).toBe("projects");
    expect(params?.mergeStrategy).toBe("upsert");
    expect(params?.value).toEqual({ "/work/repo": { trust_level: "trusted" } });
    await client.close();
  });

  it("setThreadPermissions resumes with the permission overlay", async () => {
    const fake = new FeatureFakeTransport();
    const client = new CodexThreadClient({ transportFactory: () => fake });
    await client.startThread();

    const result = await client.setThreadPermissions({
      threadId: "thread-1",
      model: "gpt-5-codex",
      approvalPolicy: "never",
      sandbox: "workspace-write"
    });
    expect(result).toEqual({ threadId: "thread-1" });
    const params = fake.paramsFor("thread/resume");
    expect(params?.model).toBe("gpt-5-codex");
    expect(params?.approvalPolicy).toBe("never");
    expect(params?.sandbox).toBe("workspace-write");
    await client.close();
  });
});
