import { describe, it, expect, vi } from "vitest";
import fc from "fast-check";
import { JsonRpcConnection, type JsonRpcTransport } from "../src/index";
import { noopLogger } from "@pwrdrvr/agent-core";

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

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

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

  it("reports malformed inbound JSON without logging its content", async () => {
    const fake = new FakeTransport();
    const warn = vi.fn();
    const conn = new JsonRpcConnection(fake, 1000, undefined, {
      logger: { ...noopLogger, warn }, logContext: { owner: "fixture" }
    });
    expect(() => fake.inboundRaw("{not json")).not.toThrow();
    await tick();
    expect(fake.sent).toHaveLength(0);
    expect(warn).toHaveBeenCalledExactlyOnceWith("json-rpc invalid inbound message", {
      owner: "fixture", length: 9
    });
    const next = conn.request("still-connected");
    await tick();
    fake.inbound({ id: fake.sentEnvelope(0).id, result: { ok: true } });
    await expect(next).resolves.toEqual({ ok: true });
  });

  it("rejects pending requests when the transport closes", async () => {
    const fake = new FakeTransport();
    const conn = new JsonRpcConnection(fake, 1000);
    const p = conn.request("inflight");
    await tick();
    fake.triggerClose(new Error("pipe died"));
    await expect(p).rejects.toThrow(/pipe died/);
  });

  it.each(["transport close", "explicit close", "timeout"])(
    "settles a request on %s while the outbound observer is blocked",
    async (cause) => {
      vi.useFakeTimers();
      const resume = deferred<void>();
      try {
        const fake = new FakeTransport();
        const observing = deferred<void>();
        const conn = new JsonRpcConnection(fake, 1_000, {
          onMessage: ({ direction }) => {
            if (direction !== "outbound") return;
            observing.resolve();
            return resume.promise;
          }
        });
        await conn.connect();
        const rejected = vi.fn();
        void conn.request("blocked").catch(rejected);
        await observing.promise;

        const failure = new Error("pipe died");
        if (cause === "transport close") fake.triggerClose(failure);
        if (cause === "explicit close") await conn.close();
        await vi.advanceTimersByTimeAsync(cause === "timeout" ? 1_000 : 0);
        const expected = {
          "transport close": failure.message,
          "explicit close": "json-rpc transport closed",
          timeout: "json-rpc timeout: blocked"
        }[cause];
        expect(rejected).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ message: expected }));
        expect(vi.getTimerCount()).toBe(0);

        await conn.connect();
        resume.resolve();
        await vi.advanceTimersByTimeAsync(0);
        expect(fake.sent).toEqual([]);
      } finally {
        resume.resolve();
        vi.useRealTimers();
      }
    }
  );

  it.each([
    { outcome: "result", when: "after disconnect", reconnectFirst: false },
    { outcome: "error", when: "after reconnect", reconnectFirst: true }
  ])("drops a child request's late $outcome $when", async ({ reconnectFirst }) => {
    const fake = new FakeTransport();
    const connect = vi.spyOn(fake, "connect");
    const conn = new JsonRpcConnection(fake, 1_000);
    const started = deferred<void>();
    const reply = deferred<unknown>();
    conn.setRequestHandler(() => {
      started.resolve();
      return reply.promise;
    });
    await conn.connect();
    fake.inbound({ jsonrpc: "2.0", id: 42, method: "old/request" });
    await started.promise;
    fake.triggerClose(new Error("pipe died"));

    if (reconnectFirst) {
      await conn.connect();
      reply.reject(new Error("old handler failed"));
    } else {
      reply.resolve({ old: true });
    }
    await tick();
    expect(fake.sent).toEqual([]);
    await conn.connect();
    expect(connect).toHaveBeenCalledTimes(2);

    conn.setRequestHandler(async () => ({ fresh: true }));
    fake.inbound({ jsonrpc: "2.0", id: 42, method: "new/request" });
    await tick();
    expect(fake.sent.map((raw) => JSON.parse(raw))).toEqual([
      { jsonrpc: "2.0", id: 42, result: { fresh: true } }
    ]);
  });

  it("drops a child reply held by the outbound observer across an explicit close and reconnect", async () => {
    const fake = new FakeTransport();
    const started = deferred<void>();
    const resume = deferred<void>();
    const conn = new JsonRpcConnection(fake, 1_000, {
      onMessage: ({ direction }) => {
        if (direction !== "outbound") return;
        started.resolve();
        return resume.promise;
      }
    });
    await conn.connect();
    fake.inbound({ jsonrpc: "2.0", id: 42, method: "old/request" });
    await started.promise;
    await conn.close();
    await conn.connect();
    resume.resolve();
    await tick();
    expect(fake.sent).toEqual([]);
  });

  it("matches the request model across observer delays, replies, timeouts and reconnects", async () => {
    const action = fc.constantFrom(
      "request", "allow write", "response", "error response", "child request", "finish handler",
      "advance clock", "disconnect", "close", "connect"
    );
    const step = fc.tuple(action, fc.nat(7));
    const timeout = 100;
    vi.useFakeTimers();
    try {
      await fc.assert(fc.asyncProperty(fc.array(step, { maxLength: 40 }), async (steps) => {
        type Outcome = ["resolved" | "rejected", string];
        type ClientRequest = {
          method: string;
          seen: { id: string | number; gate: ReturnType<typeof deferred<void>> };
          onSettled: ReturnType<typeof vi.fn>;
          deadline: number;
          sent: boolean;
          outcome?: Outcome;
        };
        const clientRequests: ClientRequest[] = [];
        const childRequests: Array<{ id: number; generation: number; completed: boolean }> = [];
        const observed = new Map<string, ClientRequest["seen"]>();
        const handlers = new Map<number, ReturnType<typeof deferred<number>>>();
        const expectedWrites: unknown[] = [];
        const fake = new FakeTransport();
        const conn = new JsonRpcConnection(fake, timeout, {
          onMessage: ({ direction, envelope }) => {
            if (direction !== "outbound" || !envelope.method || envelope.id == null) return;
            const gate = deferred<void>();
            observed.set(envelope.method, { id: envelope.id, gate });
            return gate.promise;
          }
        });
        conn.setRequestHandler((_method, _params, id) => {
          const handler = deferred<number>();
          handlers.set(Number(id), handler);
          return handler.promise;
        });
        let connected = true;
        let generation = 0;
        let now = 0;
        await conn.connect();
        try {
          for (const [index, [command, slot]] of steps.entries()) {
            const request = clientRequests[slot % clientRequests.length];
            const child = childRequests[slot % childRequests.length];
            switch (command) {
              case "request": {
                if (!connected) break;
                const method = `request-${index}`;
                const onSettled = vi.fn();
                void conn.request(method).then(
                  (value) => onSettled("resolved", value), (error: Error) => onSettled("rejected", error.message)
                );
                const seen = observed.get(method)!;
                expect(clientRequests.map((previous) => previous.seen.id)).not.toContain(seen.id);
                clientRequests.push({ method, seen, onSettled, deadline: now + timeout, sent: false });
                break;
              }
              case "allow write":
                if (!request) break;
                request.seen.gate.resolve();
                if (!request.sent && request.outcome === undefined) {
                  request.sent = true;
                  expectedWrites.push({ jsonrpc: "2.0", id: request.seen.id, method: request.method, params: {} });
                }
                break;
              case "response":
                if (!connected || !request?.sent) break;
                fake.inbound({ jsonrpc: "2.0", id: request.seen.id, result: `response-${index}` });
                request.outcome ??= ["resolved", `response-${index}`];
                break;
              case "error response":
                if (!connected || !request?.sent) break;
                fake.inbound({ jsonrpc: "2.0", id: request.seen.id, error: { code: -32000, message: `error-${index}` } });
                request.outcome ??= ["rejected", `json-rpc error (-32000): error-${index}`];
                break;
              case "child request":
                if (!connected) break;
                childRequests.push({ id: index, generation, completed: false });
                fake.inbound({ jsonrpc: "2.0", id: index, method: "child/request" });
                break;
              case "finish handler":
                if (!child || child.completed) break;
                child.completed = true;
                handlers.get(child.id)!.resolve(index);
                if (connected && child.generation === generation) {
                  expectedWrites.push({ jsonrpc: "2.0", id: child.id, result: index });
                }
                break;
              case "advance clock": {
                const elapsed = slot % 2 === 0 ? timeout / 2 : timeout;
                now += elapsed;
                await vi.advanceTimersByTimeAsync(elapsed);
                for (const pending of clientRequests) {
                  if (pending.deadline <= now) pending.outcome ??= ["rejected", `json-rpc timeout: ${pending.method}`];
                }
                break;
              }
              case "disconnect":
              case "close": {
                const reason = command === "disconnect" ? "pipe failed" : "json-rpc transport closed";
                if (command === "disconnect") fake.triggerClose(new Error(reason));
                else await conn.close();
                connected = false;
                for (const pending of clientRequests) pending.outcome ??= ["rejected", reason];
                break;
              }
              case "connect":
                await conn.connect();
                if (!connected) generation++;
                connected = true;
                break;
            }
            await vi.advanceTimersByTimeAsync(0);
            expect(fake.sent.map((raw) => JSON.parse(raw))).toEqual(expectedWrites);
            for (const pending of clientRequests) {
              expect(pending.onSettled.mock.calls).toEqual(pending.outcome === undefined ? [] : [pending.outcome]);
            }
            expect(vi.getTimerCount()).toBe(clientRequests.filter(({ outcome }) => outcome === undefined).length);
          }
        } finally {
          await conn.close();
          for (const { gate } of observed.values()) gate.resolve();
          for (const handler of handlers.values()) handler.resolve(0);
          await vi.advanceTimersByTimeAsync(0);
        }
      }), {
        examples: [
          [[
            ["request", 0], ["request", 0], ["allow write", 1], ["response", 1],
            ["child request", 0], ["disconnect", 0], ["connect", 0],
            ["finish handler", 0], ["allow write", 0], ["response", 1],
            ["child request", 0], ["finish handler", 1]
          ]],
          [[
            ["request", 0], ["advance clock", 0], ["request", 0], ["allow write", 1],
            ["advance clock", 0], ["allow write", 0], ["error response", 1], ["response", 1]
          ]]
        ]
      });
    } finally {
      vi.useRealTimers();
    }
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
