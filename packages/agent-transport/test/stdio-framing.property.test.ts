import { EventEmitter, once } from "node:events";
import { PassThrough } from "node:stream";
import fc from "fast-check";
import { describe, expect, it, vi } from "vitest";
import { StdioJsonRpcTransport } from "../src/stdio-transport";
import { readJsonRpcLines } from "../src/json-rpc-lines";

const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }));
vi.mock("node:child_process", () => ({ spawn: spawnMock }));

// Generate arbitrary JS UTF-16 strings, including lone surrogates (escaped by
// JSON.stringify), controls, non-BMP characters, and literal JSON separators.
const text = fc.array(fc.integer({ min: 0, max: 0xffff }), { maxLength: 80 })
  .map((units) => String.fromCharCode(...units));

async function receive(wire: Buffer, sizes: number[]): Promise<string[]> {
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
    kill: vi.fn(() => true)
  });
  spawnMock.mockReturnValue(child);
  const transport = new StdioJsonRpcTransport({ command: "fixture" });
  const lines: string[] = [];
  transport.setMessageHandler((line) => lines.push(line));
  await transport.connect();
  try {
    for (let offset = 0, i = 0; offset < wire.length; i++) {
      const end = Math.min(wire.length, offset + sizes[i % sizes.length]!);
      child.stdout.write(wire.subarray(offset, end));
      offset = end;
    }
    const ended = once(child.stdout, "end");
    child.stdout.end();
    await ended;
    expect(child.kill).not.toHaveBeenCalled();
    return lines;
  } finally {
    await transport.close();
    child.emit("exit", null, "SIGTERM");
    expect(child.kill).toHaveBeenCalledTimes(1);
  }
}

describe("stdio framing oracle", () => {
  it("detaches without destroying the caller-owned input", () => {
    const input = new PassThrough();
    const lines: string[] = [];
    const stop = readJsonRpcLines(input, (line) => lines.push(line));
    input.write("{}\npartial");
    stop();
    stop();
    input.write("tail\n");
    expect(lines).toEqual(["{}"]);
    expect(input.destroyed).toBe(false);
    expect(input.listenerCount("data")).toBe(0);
    expect(input.listenerCount("end")).toBe(0);
    input.end();
  });

  it("preserves serialized JSON strings for arbitrary text and byte partitions", async () => {
    await fc.assert(fc.asyncProperty(
      fc.array(text, { minLength: 1, maxLength: 5 }),
      fc.array(fc.integer({ min: 1, max: 101 }), { minLength: 1, maxLength: 15 }),
      fc.boolean(), fc.boolean(),
      async (texts, sizes, crlf, finalLf) => {
        const frames = texts.map((value, id) => JSON.stringify({
          jsonrpc: "2.0", id, result: { [value]: value, sentinel: "\u2028\u2029🛰️\r\n\u0000" }
        }));
        const delimiter = crlf ? "\r\n" : "\n";
        const wire = Buffer.from(frames.join(delimiter) + (finalLf ? delimiter : ""));
        // The independent oracle is the original serialized envelope sequence,
        // not a second streaming parser or readline implementation.
        expect(await receive(wire, sizes)).toEqual(frames);
      }
    ), { numRuns: 100 });
  });

  it("preserves separators at every possible two-chunk byte boundary", async () => {
    const frames = [JSON.stringify({ result: "a\u2028b\u2029é🛰️\r\n\ud800" }), "{}"];
    const wire = Buffer.from(frames.join("\r\n") + "\r\n");
    for (let split = 1; split < wire.length; split++) {
      expect(await receive(wire, [split, wire.length])).toEqual(frames);
    }
    expect(await receive(wire, [1])).toEqual(frames);
  });

  it("emits empty LF frames and an unterminated EOF tail without splitting bare CR", async () => {
    expect(await receive(Buffer.from("\n\r\n{}\r {}\n{}\r"), [1]))
      .toEqual(["", "", "{}\r {}", "{}"]);
    expect(await receive(Buffer.alloc(0), [1])).toEqual([]);
  });
});
