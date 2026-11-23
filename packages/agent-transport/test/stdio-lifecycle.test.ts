import type { ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { EventEmitter, once } from "node:events";
import { PassThrough } from "node:stream";
import fc from "fast-check";
import { describe, expect, it, vi } from "vitest";
import { JsonRpcConnection } from "../src/json-rpc";
import { StdioJsonRpcTransport } from "../src/stdio-transport";

const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }));
vi.mock("node:child_process", () => ({ spawn: spawnMock }));

const BROKEN_STDIN_SERVER = String.raw`
const fs = require("node:fs");
const buffer = Buffer.alloc(1024);
let line = "";
while (!line.includes("\n")) {
  const size = fs.readSync(0, buffer);
  if (size === 0) process.exit(1);
  line += buffer.toString("utf8", 0, size);
}
const request = JSON.parse(line);
if (request.method !== "initialize") process.exit(1);
if (process.argv[1] === "ignore-sigterm") process.on("SIGTERM", () => {});
fs.closeSync(0);
process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { ready: true } }) + "\n");
setInterval(() => {}, 1000);
`;

const FIXTURE_EXIT_TIMEOUT_MS = 2_500;

async function spawnFixture(script: string, args: string[] = []): Promise<ChildProcessWithoutNullStreams> {
  const { spawn: realSpawn } = await vi.importActual<{ spawn: typeof spawn }>("node:child_process");
  const child = realSpawn(process.execPath, ["-e", script, ...args], {
    stdio: ["pipe", "pipe", "pipe"]
  });
  spawnMock.mockReturnValue(child);
  return child;
}

async function waitForExit(child: ChildProcessWithoutNullStreams): Promise<unknown[]> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return [child.exitCode, child.signalCode];
  }
  return await once(child, "exit", { signal: AbortSignal.timeout(FIXTURE_EXIT_TIMEOUT_MS) });
}

async function stopFixture(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGKILL");
  await waitForExit(child);
}

function createChild() {
  return Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    exitCode: null as number | null,
    signalCode: null,
    kill: vi.fn(() => true)
  });
}

const childEvents = fc.constantFrom("stdin", "stdout", "stderr", "process", "exit", "stdio close", "message");
const lifecycleStep = fc.oneof(
  fc.record({ action: fc.constantFrom("connect", "close", "send") }),
  fc.record({ action: childEvents, target: fc.oneof(fc.constant("current" as const), fc.nat(7)) }),
  fc.record({ action: fc.constant("advance" as const), ms: fc.constantFrom(1, 500, 999, 1_000) })
);

describe("StdioJsonRpcTransport lifecycle", () => {
  it.runIf(process.platform !== "win32").each([
    { args: [], exitSignal: "SIGTERM", signals: [[]] },
    { args: ["ignore-sigterm"], exitSignal: "SIGKILL", signals: [[], ["SIGKILL"]] }
  ])("rejects session/new with EPIPE and reaps the child with $exitSignal", async ({ args, exitSignal, signals }) => {
    const child = await spawnFixture(BROKEN_STDIN_SERVER, args);
    const kill = vi.spyOn(child, "kill");
    const transport = new StdioJsonRpcTransport({ command: "fixture" });
    const connection = new JsonRpcConnection(transport, 1_000);
    try {
      await connection.connect();
      await expect(connection.request("initialize")).resolves.toEqual({ ready: true });
      expect(child.exitCode).toBeNull();
      expect(child.signalCode).toBeNull();

      const requests = [connection.request("session/new"), connection.request("other")];
      await expect(Promise.allSettled(requests)).resolves.toEqual(requests.map(() => ({
        status: "rejected",
        reason: expect.objectContaining({ code: "EPIPE" })
      })));
      expect(() => transport.send("{}")).toThrow("agent stdio not connected");
      await expect(waitForExit(child)).resolves.toEqual([null, exitSignal]);
      await connection.close();
      expect(kill.mock.calls).toEqual(signals);
    } finally {
      await stopFixture(child);
      await connection.close();
    }
  }, 10_000);

  it("delivers an already-read notification when the observer resumes after clean exit", async () => {
    const child = await spawnFixture(
      'process.stdout.write(JSON.stringify({ jsonrpc: "2.0", method: "turn/completed", params: { id: 42 } }))'
    );
    const closed = once(child, "close", { signal: AbortSignal.timeout(FIXTURE_EXIT_TIMEOUT_MS) });
    let releaseObserver!: () => void;
    const observing = new Promise<void>((resolve) => { releaseObserver = resolve; });
    const onMessage = vi.fn(() => observing);
    const onNotification = vi.fn();
    const transport = new StdioJsonRpcTransport({ command: "fixture" });
    const connection = new JsonRpcConnection(transport, 1_000, { onMessage });
    connection.setNotificationHandler(onNotification);

    try {
      await connection.connect();
      await expect(closed).resolves.toEqual([0, null]);
      expect(onMessage).toHaveBeenCalledTimes(1);
      expect(onNotification).not.toHaveBeenCalled();
      releaseObserver();
      await vi.waitFor(() => {
        expect(onNotification).toHaveBeenCalledExactlyOnceWith("turn/completed", { id: 42 });
      });
    } finally {
      releaseObserver();
      await stopFixture(child);
      await connection.close();
    }
  });

  it("disconnects when writing to destroyed stdin fails only through the write callback", async () => {
    const child = createChild();
    spawnMock.mockReturnValue(child);
    const transport = new StdioJsonRpcTransport({ command: "fixture" });
    const connection = new JsonRpcConnection(transport, 1_000);
    await connection.connect();
    child.stdin.destroy();
    try {
      await expect(connection.request("session/new")).rejects.toMatchObject({
        code: "ERR_STREAM_DESTROYED"
      });
      expect(() => transport.send("{}")).toThrow("agent stdio not connected");
    } finally {
      await connection.close();
      child.emit("exit", null, "SIGTERM");
    }
    expect(child.kill).toHaveBeenCalledTimes(1);
  });

  it("escalates only the retired child that is still running after reconnect", async () => {
    vi.useFakeTimers();
    const exited = createChild();
    const stuck = createChild();
    const replacement = createChild();
    spawnMock.mockReturnValueOnce(exited).mockReturnValueOnce(stuck).mockReturnValueOnce(replacement);
    const transport = new StdioJsonRpcTransport({ command: "fixture" });
    try {
      await transport.connect();
      exited.stdin.emit("error", new Error("broken pipe"));
      await transport.connect();
      stuck.stdin.emit("error", new Error("broken pipe"));
      await transport.close();
      await transport.connect();
      expect(exited.kill.mock.calls).toEqual([[]]);
      expect(stuck.kill.mock.calls).toEqual([[]]);

      exited.exitCode = 0;
      exited.emit("exit", 0, null);
      expect(vi.getTimerCount()).toBe(1);
      await vi.runOnlyPendingTimersAsync();
      expect(exited.kill.mock.calls).toEqual([[]]);
      expect(stuck.kill.mock.calls).toEqual([[], ["SIGKILL"]]);
      expect(replacement.kill).not.toHaveBeenCalled();
      transport.send("{}");
    } finally {
      await transport.close();
      for (const child of [exited, stuck, replacement]) child.emit("exit", null, "SIGTERM");
      vi.useRealTimers();
    }
  });

  it("matches the lifecycle model while retired children are still owned", async () => {
    await fc.assert(fc.asyncProperty(fc.array(lifecycleStep, { maxLength: 50 }), async (steps) => {
      const terminationGraceMs = 1_000;
      const children: Array<{
        process: ReturnType<typeof createChild>;
        writes: string[];
        expectedWrites: string[];
        expectedSignals: Array<[] | ["SIGKILL"]>;
        escalationAt?: number;
        exited: boolean;
        stdioClosed: boolean;
      }> = [];
      spawnMock.mockImplementation(() => {
        const child = createChild();
        const writes: string[] = [];
        child.stdin.on("data", (data: Buffer) => writes.push(data.toString()));
        children.push({ process: child, writes, expectedWrites: [], expectedSignals: [], exited: false, stdioClosed: false });
        return child;
      });
      const transport = new StdioJsonRpcTransport({ command: "fixture" });
      const closes = vi.fn();
      const messages = vi.fn();
      transport.setCloseHandler(closes);
      transport.setMessageHandler(messages);
      let current: number | undefined;
      const retired: number[] = [];
      let now = 0;
      let expectedChildren = 0;
      const expectedCloses: Array<Error | undefined> = [];
      const expectedMessages: string[] = [];
      const detach = (reason?: Error) => {
        retired.push(current!);
        current = undefined;
        expectedCloses.push(reason);
      };
      const expectTermination = (child: typeof children[number]) => {
        if (child.exited) return;
        child.expectedSignals.push([]);
        child.escalationAt = now + terminationGraceMs;
      };
      vi.useFakeTimers();
      try {
        for (const [index, step] of steps.entries()) {
          const message = JSON.stringify({ index });
          const active = current === undefined ? undefined : children[current]!;
          if (step.action === "connect") {
            await transport.connect();
            if (current === undefined) current = expectedChildren++;
          } else if (step.action === "send") {
            if (active) {
              active.expectedWrites.push(`${message}\n`);
              transport.send(message);
            } else {
              expect(() => transport.send(message)).toThrow("agent stdio not connected");
            }
          } else if (step.action === "close") {
            await transport.close();
            if (active) {
              expectTermination(active);
              detach();
            }
          } else if (step.action === "advance") {
            now += step.ms;
            await vi.advanceTimersByTimeAsync(step.ms);
            for (const child of children) {
              if (child.escalationAt !== undefined && child.escalationAt <= now) {
                child.expectedSignals.push(["SIGKILL"]);
                delete child.escalationAt;
              }
            }
          } else if ("target" in step) {
            const target = step.target === "current" ? current : retired[step.target % retired.length];
            if (target === undefined) continue;
            const child = children[target]!;
            if (child.stdioClosed) continue;
            if (step.action === "message") {
              if (target === current) expectedMessages.push(message);
              child.process.stdout.write(`${message}\n`);
            } else if (step.action === "exit" || step.action === "stdio close") {
              if (!child.exited) {
                child.exited = true;
                delete child.escalationAt;
                child.process.exitCode = 0;
                child.process.emit("exit", 0, null);
              }
              if (step.action === "stdio close") {
                child.stdioClosed = true;
                child.process.emit("close", 0, null);
                if (target === current) detach();
              }
            } else {
              const error = new Error(step.action);
              const emitter = step.action === "process" ? child.process : child.process[step.action];
              emitter.emit("error", error);
              if (target === current) {
                expectTermination(child);
                detach(error);
              }
            }
          }

          expect(children).toHaveLength(expectedChildren);
          expect(closes.mock.calls.map(([error]) => error)).toEqual(expectedCloses);
          expect(messages.mock.calls.map(([line]) => line)).toEqual(expectedMessages);
          for (const child of children) {
            expect(child.writes).toEqual(child.expectedWrites);
            expect(child.process.kill.mock.calls).toEqual(child.expectedSignals);
          }
          expect(vi.getTimerCount()).toBe(children.filter(({ escalationAt }) => escalationAt !== undefined).length);
        }
      } finally {
        await transport.close();
        for (const { process: child } of children) child.emit("exit", null, "SIGTERM");
        vi.useRealTimers();
      }
    }), {
      examples: [[[
        { action: "connect" },
        { action: "connect" },
        { action: "send" },
        { action: "stdin", target: "current" },
        { action: "send" },
        { action: "connect" },
        { action: "advance", ms: 500 },
        { action: "close" },
        { action: "close" },
        { action: "connect" },
        { action: "stdout", target: 0 },
        { action: "stderr", target: 1 },
        { action: "process", target: 0 },
        { action: "message", target: 1 },
        { action: "exit", target: 0 },
        { action: "advance", ms: 999 },
        { action: "advance", ms: 1 },
        { action: "advance", ms: 1_000 },
        { action: "stdio close", target: 1 },
        { action: "stdio close", target: 0 },
        { action: "send" },
        { action: "exit", target: "current" },
        { action: "message", target: "current" },
        { action: "stdio close", target: "current" },
        { action: "connect" },
        { action: "stdout", target: "current" },
        { action: "connect" },
        { action: "stderr", target: "current" },
        { action: "connect" },
        { action: "process", target: "current" },
        { action: "close" }
      ]]]
    });
  });
});
