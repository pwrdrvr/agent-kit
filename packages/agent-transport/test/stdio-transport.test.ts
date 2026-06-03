import { describe, it, expect } from "vitest";
import { JsonRpcConnection, StdioJsonRpcTransport } from "../src/index";

// A minimal JSON-RPC echo server run as a real child process over stdio.
const ECHO_SERVER = `
const readline = require('node:readline');
const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  if (msg.id != null && msg.method === 'echo') {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { echoed: msg.params } }) + '\\n');
  } else if (msg.id != null && msg.method === 'boom') {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { code: -32001, message: 'kaboom' } }) + '\\n');
  }
});
`;

describe("StdioJsonRpcTransport (real subprocess)", () => {
  it("round-trips a request/response over real stdio", async () => {
    const transport = new StdioJsonRpcTransport({
      command: process.execPath,
      args: ["-e", ECHO_SERVER]
    });
    const conn = new JsonRpcConnection(transport, 3000);
    await conn.connect();
    try {
      const result = await conn.request("echo", { hello: "world" });
      expect(result).toEqual({ echoed: { hello: "world" } });
    } finally {
      await conn.close();
    }
  });

  it("propagates a server error envelope over real stdio", async () => {
    const transport = new StdioJsonRpcTransport({
      command: process.execPath,
      args: ["-e", ECHO_SERVER]
    });
    const conn = new JsonRpcConnection(transport, 3000);
    await conn.connect();
    try {
      await expect(conn.request("boom")).rejects.toThrow(/-32001.*kaboom/);
    } finally {
      await conn.close();
    }
  });

  it("rejects in-flight requests when the child exits", async () => {
    const transport = new StdioJsonRpcTransport({
      command: process.execPath,
      // a process that exits immediately — no response will come
      args: ["-e", "process.exit(0)"]
    });
    const conn = new JsonRpcConnection(transport, 3000);
    await conn.connect();
    await expect(conn.request("echo", {})).rejects.toThrow(/closed/);
  });
});
