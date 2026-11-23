import { type spawn } from "node:child_process";
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
fs.closeSync(0);
process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { ready: true } }) + "\n");
setInterval(() => {}, 1000);
`;

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

const childEvents = fc.constantFrom("stdin", "stdout", "stderr", "process", "exit", "message");
const lifecycleStep = fc.oneof(
  fc.record({ action: fc.constantFrom("connect", "close", "send") }),
  fc.record({ action: childEvents, target: fc.constantFrom("current", "retired") })
);

describe("StdioJsonRpcTransport lifecycle", () => {
  it.runIf(process.platform !== "win32")("rejects session/new with EPIPE after initialize and reaps the child", async () => {
    const { spawn: realSpawn } = await vi.importActual<{ spawn: typeof spawn }>("node:child_process");
    const child = realSpawn(process.execPath, ["-e", BROKEN_STDIN_SERVER], {
      stdio: ["pipe", "pipe", "pipe"]
    });
    const childExited = once(child, "exit");
    const kill = vi.spyOn(child, "kill");
    spawnMock.mockReturnValue(child);
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
      await expect(childExited).resolves.toEqual([null, "SIGTERM"]);
      expect(() => transport.send("{}")).toThrow("agent stdio not connected");
      await connection.close();
      expect(kill).toHaveBeenCalledTimes(1);
    } finally {
      await connection.close();
      if (child.exitCode === null && child.signalCode === null && !child.killed) child.kill();
      await childExited;
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
    }
    expect(child.kill).toHaveBeenCalledTimes(1);
  });

  it("matches the lifecycle model across stream failures, closes and reconnects", async () => {
    await fc.assert(fc.asyncProperty(fc.array(lifecycleStep, { maxLength: 50 }), async (steps) => {
      const children: Array<{
        process: ReturnType<typeof createChild>;
        writes: string[];
        expectedWrites: string[];
        expectedKills: number;
      }> = [];
      spawnMock.mockImplementation(() => {
        const child = createChild();
        const writes: string[] = [];
        child.stdin.on("data", (data: Buffer) => writes.push(data.toString()));
        children.push({ process: child, writes, expectedWrites: [], expectedKills: 0 });
        return child;
      });
      const transport = new StdioJsonRpcTransport({ command: "fixture" });
      const closes = vi.fn();
      const messages = vi.fn();
      transport.setCloseHandler(closes);
      transport.setMessageHandler(messages);
      let current: number | undefined;
      let retired: number | undefined;
      let expectedChildren = 0;
      const expectedCloses: Array<Error | undefined> = [];
      const expectedMessages: string[] = [];
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
              active.expectedKills++;
              expectedCloses.push(undefined);
              retired = current;
              current = undefined;
            }
          } else if ("target" in step) {
            const target = step.target === "current" ? current : retired;
            if (target === undefined) continue;
            const child = children[target]!;
            if (step.action === "message") {
              if (target === current) expectedMessages.push(message);
              child.process.stdout.write(`${message}\n`);
            } else {
              const error = step.action === "exit" ? undefined : new Error(step.action);
              if (target === current) {
                if (error) child.expectedKills++;
                expectedCloses.push(error);
                retired = current;
                current = undefined;
              }
              if (step.action === "exit") {
                child.process.exitCode = 0;
                child.process.emit("close", 0, null);
              } else {
                const emitter = step.action === "process" ? child.process : child.process[step.action];
                emitter.emit("error", error);
              }
            }
          }

          expect(children).toHaveLength(expectedChildren);
          expect(closes.mock.calls.map(([error]) => error)).toEqual(expectedCloses);
          expect(messages.mock.calls.map(([line]) => line)).toEqual(expectedMessages);
          for (const child of children) {
            expect(child.writes).toEqual(child.expectedWrites);
            expect(child.process.kill).toHaveBeenCalledTimes(child.expectedKills);
          }
        }
      } finally {
        await transport.close();
      }
    }), {
      examples: [[[
        { action: "connect" },
        { action: "connect" },
        { action: "send" },
        { action: "stdin", target: "current" },
        { action: "send" },
        { action: "connect" },
        { action: "stdout", target: "retired" },
        { action: "stderr", target: "retired" },
        { action: "process", target: "retired" },
        { action: "message", target: "retired" },
        { action: "exit", target: "retired" },
        { action: "message", target: "current" },
        { action: "send" },
        { action: "close" },
        { action: "close" },
        { action: "connect" },
        { action: "exit", target: "retired" },
        { action: "send" },
        { action: "exit", target: "current" },
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
