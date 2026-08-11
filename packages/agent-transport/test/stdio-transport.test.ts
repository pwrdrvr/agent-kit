import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
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

describe.runIf(process.platform === "win32")("StdioJsonRpcTransport (Windows batch shim)", () => {
  it("round-trips over an npm-style .cmd without evaluating launch arguments", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "agent-transport-win-"));
    const bin = path.join(root, "ACP & shims");
    const marker = path.join(root, "injected.txt");
    const script = path.join(bin, "echo-server.cjs");
    const shim = path.join(bin, "echo-server.cmd");
    const dangerousArgument = `probe & echo injected>"${marker}"`;
    mkdirSync(bin, { recursive: true });
    writeFileSync(script, `
const readline = require("node:readline");
const expected = process.env.EXPECTED_LAUNCH_ARG;
const launchArg = process.argv[2];
const firstPathDir = (process.env.Path || process.env.PATH || "").split(";")[0];
const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const msg = JSON.parse(line);
  process.stdout.write(JSON.stringify({
    jsonrpc: "2.0",
    id: msg.id,
    result: { launchArg, expected, firstPathDir, echoed: msg.params }
  }) + "\\n");
});
`, "utf8");
    writeFileSync(
      shim,
      `@ECHO off\nSETLOCAL\nnode "%~dp0\\echo-server.cjs" %*\n`,
      "utf8"
    );

    const env = { ...process.env };
    for (const key of Object.keys(env)) {
      if (key.toLowerCase() === "path") delete env[key];
    }
    env.Path = path.dirname(process.execPath);
    env.EXPECTED_LAUNCH_ARG = dangerousArgument;
    const transport = new StdioJsonRpcTransport({
      command: shim,
      args: [dangerousArgument],
      env
    });
    const connection = new JsonRpcConnection(transport, 3_000);

    try {
      await connection.connect();
      const result = await connection.request("echo", { hello: "windows" });
      expect(result).toEqual({
        launchArg: dangerousArgument,
        expected: dangerousArgument,
        firstPathDir: bin,
        echoed: { hello: "windows" }
      });
      expect(existsSync(marker)).toBe(false);
    } finally {
      await connection.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
