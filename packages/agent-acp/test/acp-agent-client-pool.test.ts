import { describe, expect, it, vi } from "vitest";
import fc from "fast-check";
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

  it("matches the per-key model across shared warm-ups, eviction and late completions", async () => {
    const keys = ["gemini", "qwen"] as const;
    const step = fc.tuple(
      fc.constantFrom("acquire", "ready", "fail", "release", "timeout", "close all"),
      fc.constantFrom(...keys),
      fc.nat(7)
    );
    const warmTimeoutMs = 50;
    vi.useFakeTimers();
    try {
      await fc.assert(fc.asyncProperty(fc.array(step, { maxLength: 40 }), async (steps) => {
        type Attempt = {
          key: typeof keys[number];
          client: FakeClient;
          callers: Array<ReturnType<typeof vi.fn>>;
          state: "warming" | "ready" | "failed" | "timed out";
          closed: boolean;
        };
        const pool = new AcpAgentClientPool({ warmTimeoutMs });
        const current = new Map<Attempt["key"], Attempt>();
        const attempts: Attempt[] = [];
        const clients: FakeClient[] = [];
        const factory = () => {
          const client = new FakeClient(false);
          clients.push(client);
          return asClient(client);
        };
        try {
          for (const [action, key, slot] of steps) {
            const history = attempts.filter((attempt) => attempt.key === key);
            const selected = history[slot % history.length];
            const active = current.get(key);
            switch (action) {
              case "acquire": {
                const settled = vi.fn();
                void pool.acquire(key, factory).then(settled, (error: Error) => settled(error.message));
                const attempt = active ?? {
                  key, client: clients.at(-1)!,
                  callers: [], state: "warming", closed: false
                };
                if (!active) {
                  attempts.push(attempt);
                  current.set(key, attempt);
                }
                attempt.callers.push(settled);
                break;
              }
              case "ready":
                if (selected?.state !== "warming") break;
                selected.client.finishConnect();
                selected.state = "ready";
                break;
              case "fail":
                if (selected?.state !== "warming") break;
                selected.client.failConnect();
                selected.state = "failed";
                selected.closed = true;
                if (selected === active) current.delete(key);
                break;
              case "release":
                await pool.release(key);
                if (active) active.closed = true;
                current.delete(key);
                break;
              case "timeout":
                await vi.advanceTimersByTimeAsync(warmTimeoutMs);
                for (const attempt of attempts) {
                  if (attempt.state !== "warming") continue;
                  attempt.state = "timed out";
                  attempt.closed = true;
                  if (current.get(attempt.key) === attempt) current.delete(attempt.key);
                }
                break;
              case "close all":
                await pool.closeAll();
                for (const attempt of current.values()) attempt.closed = true;
                current.clear();
                break;
            }
            await vi.advanceTimersByTimeAsync(0);
            expect(clients).toHaveLength(attempts.length);
            for (const name of keys) expect(pool.has(name)).toBe(current.has(name));
            for (const attempt of attempts) {
              const outcomes = {
                warming: [],
                ready: [[attempt.client]],
                failed: [["boom"]],
                "timed out": [[expect.stringContaining("warm-up timed out")]]
              };
              expect(attempt.client.connectCount).toBe(1);
              expect(attempt.client.closeCount > 0).toBe(attempt.closed);
              for (const caller of attempt.callers) expect(caller.mock.calls).toEqual(outcomes[attempt.state]);
            }
          }
        } finally {
          await pool.closeAll();
          await vi.advanceTimersByTimeAsync(warmTimeoutMs);
        }
      }), {
        examples: [[[
          ["acquire", "gemini", 0], ["acquire", "gemini", 0], ["acquire", "qwen", 0],
          ["release", "gemini", 0], ["acquire", "gemini", 0], ["fail", "gemini", 0],
          ["ready", "gemini", 1], ["acquire", "gemini", 0], ["timeout", "qwen", 0],
          ["close all", "gemini", 0]
        ]]]
      });
    } finally {
      vi.useRealTimers();
    }
  });
});
