import { describe, expect, it, vi } from "vitest";
import { AcpAgentClientPool } from "../src/acp-agent-client-pool";

/** Minimal stand-in for AcpAgentClient: records connect/close, with a
 *  controllable warm-up. */
class FakeClient {
  connectCount = 0;
  closeCount = 0;
  private resolveConnect: (() => void) | undefined;
  private rejectConnect: ((e: Error) => void) | undefined;
  private readonly auto: boolean;
  constructor(auto = true) {
    this.auto = auto;
  }
  connect(): Promise<void> {
    this.connectCount += 1;
    if (this.auto) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      this.resolveConnect = resolve;
      this.rejectConnect = reject;
    });
  }
  finishConnect(): void {
    this.resolveConnect?.();
  }
  failConnect(message = "boom"): void {
    this.rejectConnect?.(new Error(message));
  }
  async close(): Promise<void> {
    this.closeCount += 1;
  }
}

// The pool is typed against AcpAgentClient; the fake is structurally compatible
// for the methods the pool touches (connect/close).
const asClient = (c: FakeClient): never => c as unknown as never;

describe("AcpAgentClientPool", () => {
  it("returns the SAME warmed client for a key (singleton)", async () => {
    const pool = new AcpAgentClientPool();
    const made: FakeClient[] = [];
    const factory = (): never => {
      const c = new FakeClient();
      made.push(c);
      return asClient(c);
    };
    const a = await pool.acquire("gemini", factory);
    const b = await pool.acquire("gemini", factory);
    expect(a).toBe(b);
    expect(made).toHaveLength(1); // factory called once
    expect(made[0]?.connectCount).toBe(1);
  });

  it("dedups concurrent acquires onto ONE spawn (in-flight promise shared)", async () => {
    const pool = new AcpAgentClientPool();
    const client = new FakeClient(false); // manual warm-up
    const factory = vi.fn(() => asClient(client));
    const p1 = pool.acquire("gemini", factory);
    const p2 = pool.acquire("gemini", factory);
    expect(factory).toHaveBeenCalledTimes(1); // not spawned twice
    expect(client.connectCount).toBe(1);
    client.finishConnect();
    expect(await p1).toBe(await p2);
  });

  it("evicts and retries after a failed warm-up", async () => {
    const pool = new AcpAgentClientPool();
    const first = new FakeClient(false);
    const second = new FakeClient(true);
    const factory = vi
      .fn()
      .mockImplementationOnce(() => asClient(first))
      .mockImplementationOnce(() => asClient(second));
    const failing = pool.acquire("gemini", factory);
    first.failConnect("nope");
    await expect(failing).rejects.toThrow(/nope/);
    expect(first.closeCount).toBe(1); // torn down
    expect(pool.has("gemini")).toBe(false); // evicted
    // A fresh acquire spawns a new client.
    const ok = await pool.acquire("gemini", factory);
    expect(ok).toBe(asClient(second));
    expect(factory).toHaveBeenCalledTimes(2);
  });

  it("rejects on warm-up timeout and evicts", async () => {
    vi.useFakeTimers();
    try {
      const pool = new AcpAgentClientPool({ warmTimeoutMs: 50 });
      const client = new FakeClient(false); // never finishes
      const pending = pool.acquire("gemini", () => asClient(client));
      const assertion = expect(pending).rejects.toThrow(/timed out/);
      await vi.advanceTimersByTimeAsync(60);
      await assertion;
      expect(pool.has("gemini")).toBe(false);
      expect(client.closeCount).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("release() closes + evicts one key; closeAll() closes every client", async () => {
    const pool = new AcpAgentClientPool();
    const g = new FakeClient();
    const q = new FakeClient();
    await pool.acquire("gemini", () => asClient(g));
    await pool.acquire("qwen", () => asClient(q));
    await pool.release("gemini");
    expect(g.closeCount).toBe(1);
    expect(pool.has("gemini")).toBe(false);
    expect(pool.has("qwen")).toBe(true);
    await pool.closeAll();
    expect(q.closeCount).toBe(1);
    expect(pool.has("qwen")).toBe(false);
  });

  it("warm() never throws even when warm-up fails", async () => {
    const pool = new AcpAgentClientPool();
    const client = new FakeClient(false);
    expect(() => pool.warm("gemini", () => asClient(client))).not.toThrow();
    client.failConnect("startup failure");
    // flush — the rejection is swallowed + logged, not surfaced, and evicted.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(pool.has("gemini")).toBe(false);
  });
});
