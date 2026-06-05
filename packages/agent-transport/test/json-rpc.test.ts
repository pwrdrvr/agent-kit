import { describe, it, expect, vi } from "vitest";
import { JsonRpcConnection, type JsonRpcTransport } from "../src/index";

class FakeTransport implements JsonRpcTransport {
  sent: string[] = [];
  private messageHandler: (message: string) => void = () => undefined;
  private closeHandler: (error?: Error) => void = () => undefined;

  async connect(): Promise<void> {}
  async close(): Promise<void> {}
  send(message: string): void {
    this.sent.push(message);
  }
  setMessageHandler(handler: (message: string) => void): void {
    this.messageHandler = handler;
  }
  setCloseHandler(handler: (error?: Error) => void): void {
    this.closeHandler = handler;
  }

  // test helpers
  inbound(obj: unknown): void {
    this.messageHandler(JSON.stringify(obj));
  }
  inboundRaw(raw: string): void {
    this.messageHandler(raw);
  }
  triggerClose(error?: Error): void {
    this.closeHandler(error);
  }
  sentEnvelope(i: number): Record<string, unknown> {
    return JSON.parse(this.sent[i]!);
  }
}

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

describe("JsonRpcConnection", () => {
  it("resolves a request with the response matching its id", async () => {
    const fake = new FakeTransport();
    const conn = new JsonRpcConnection(fake, 1000);
    const p = conn.request("ping", { x: 1 });
    await tick();
    const id = fake.sentEnvelope(0).id;
    expect(fake.sentEnvelope(0)).toMatchObject({ jsonrpc: "2.0", method: "ping", params: { x: 1 } });
    fake.inbound({ jsonrpc: "2.0", id, result: { pong: true } });
    expect(await p).toEqual({ pong: true });
  });

  it("rejects a request on an error response", async () => {
    const fake = new FakeTransport();
    const conn = new JsonRpcConnection(fake, 1000);
    const p = conn.request("boom");
    await tick();
    const id = fake.sentEnvelope(0).id;
    fake.inbound({ jsonrpc: "2.0", id, error: { code: -32000, message: "nope" } });
    await expect(p).rejects.toThrow(/json-rpc error \(-32000\): nope/);
  });

  it("times out a request with no response", async () => {
    vi.useFakeTimers();
    try {
      const fake = new FakeTransport();
      const conn = new JsonRpcConnection(fake, 100);
      const p = conn.request("slow");
      const assertion = expect(p).rejects.toThrow(/json-rpc timeout: slow/);
      await vi.advanceTimersByTimeAsync(150);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  it("routes concurrent responses to the right callers (out of order)", async () => {
    const fake = new FakeTransport();
    const conn = new JsonRpcConnection(fake, 1000);
    const p1 = conn.request("a");
    const p2 = conn.request("b");
    await tick();
    const id1 = fake.sentEnvelope(0).id;
    const id2 = fake.sentEnvelope(1).id;
    fake.inbound({ jsonrpc: "2.0", id: id2, result: "B" });
    fake.inbound({ jsonrpc: "2.0", id: id1, result: "A" });
    expect(await p1).toBe("A");
    expect(await p2).toBe("B");
  });

  it("dispatches notifications (no id) to the notification handler", async () => {
    const fake = new FakeTransport();
    const conn = new JsonRpcConnection(fake, 1000);
    const seen: Array<[string, unknown]> = [];
    conn.setNotificationHandler((method, params) => {
      seen.push([method, params]);
    });
    fake.inbound({ jsonrpc: "2.0", method: "event/thing", params: { a: 1 } });
    await tick();
    expect(seen).toEqual([["event/thing", { a: 1 }]]);
  });

  it("answers an inbound server-request and writes the response back", async () => {
    const fake = new FakeTransport();
    const conn = new JsonRpcConnection(fake, 1000);
    conn.setRequestHandler(async (method, params) => {
      expect(method).toBe("tool/call");
      return { handled: params };
    });
    fake.inbound({ jsonrpc: "2.0", id: 42, method: "tool/call", params: { name: "draw" } });
    await tick();
    const reply = fake.sentEnvelope(0);
    expect(reply).toEqual({ jsonrpc: "2.0", id: 42, result: { handled: { name: "draw" } } });
  });

  it("returns a -32603 error envelope when the request handler throws", async () => {
    const fake = new FakeTransport();
    const conn = new JsonRpcConnection(fake, 1000);
    conn.setRequestHandler(async () => {
      throw new Error("handler exploded");
    });
    fake.inbound({ jsonrpc: "2.0", id: 7, method: "tool/call" });
    await tick();
    expect(fake.sentEnvelope(0)).toEqual({
      jsonrpc: "2.0",
      id: 7,
      error: { code: -32603, message: "handler exploded" }
    });
  });

  it("ignores malformed inbound JSON without throwing", async () => {
    const fake = new FakeTransport();
    const conn = new JsonRpcConnection(fake, 1000);
    expect(() => fake.inboundRaw("{not json")).not.toThrow();
    await tick();
    expect(fake.sent).toHaveLength(0);
  });

  it("rejects pending requests when the transport closes", async () => {
    const fake = new FakeTransport();
    const conn = new JsonRpcConnection(fake, 1000);
    const p = conn.request("inflight");
    await tick();
    fake.triggerClose(new Error("pipe died"));
    await expect(p).rejects.toThrow(/pipe died/);
  });

  it("includes the error `data` payload in the rejection message", async () => {
    const fake = new FakeTransport();
    const conn = new JsonRpcConnection(fake, 1000);
    const p = conn.request("boom");
    await tick();
    const id = fake.sentEnvelope(0).id;
    fake.inbound({
      jsonrpc: "2.0",
      id,
      error: { code: -32000, message: "upstream failed", data: { provider: "exploded" } }
    });
    // Base message AND the structured data (often the nested provider error).
    await expect(p).rejects.toThrow(/json-rpc error \(-32000\): upstream failed: .*"exploded"/);
  });

  it("truncates a huge error `data` payload to ~1000 chars", async () => {
    const fake = new FakeTransport();
    const conn = new JsonRpcConnection(fake, 1000);
    const p = conn.request("boom");
    await tick();
    const id = fake.sentEnvelope(0).id;
    fake.inbound({
      jsonrpc: "2.0",
      id,
      error: { code: -32000, message: "big", data: "x".repeat(5000) }
    });
    const err = (await p.catch((e: unknown) => e)) as Error;
    expect(err.message).toContain("...");
    expect(err.message.length).toBeLessThan(1100);
  });

  it("clears the pending timer when the transport send throws (no leak / unhandled reject)", async () => {
    vi.useFakeTimers();
    try {
      const fake = new FakeTransport();
      fake.send = () => {
        throw new Error("broken stdin pipe");
      };
      // A long, ACP-style timeout — the leaked timer would otherwise linger.
      const conn = new JsonRpcConnection(fake, 600_000);
      await expect(conn.request("doomed")).rejects.toThrow(/broken stdin pipe/);
      // The pending entry's timer must have been cleared on send failure —
      // otherwise it lingers for the full timeout and later fires an unhandled
      // rejection on the orphaned request promise.
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
