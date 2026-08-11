import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { Client } from "@agentclientprotocol/sdk";
import { AcpConnection, type AcpAgentConnection } from "../src/acp-connection";

/** A stub agent connection capturing calls + returning canned results. */
function stubConnection(overrides: Partial<AcpAgentConnection> = {}): AcpAgentConnection {
  return {
    initialize: vi.fn(async () => ({ protocolVersion: 1 })),
    newSession: vi.fn(async () => ({ sessionId: "sess-1" })),
    loadSession: vi.fn(async () => ({})),
    prompt: vi.fn(async () => ({ stopReason: "end_turn" })),
    cancel: vi.fn(async () => undefined),
    setSessionMode: vi.fn(async () => ({})),
    setSessionModel: vi.fn(async () => ({})),
    authenticate: vi.fn(async () => ({})),
    request: vi.fn(async () => ({ ok: true })),
    notify: vi.fn(async () => undefined),
    ...overrides
  };
}

/** Build an AcpConnection over a stub, capturing the library `Client` handler so
 *  tests can simulate agent→client traffic. */
function makeConnection(conn: AcpAgentConnection): {
  acp: AcpConnection;
  client: () => Client;
} {
  let captured: Client | undefined;
  const acp = new AcpConnection({
    command: "fake",
    args: [],
    createConnection: (client) => {
      captured = client;
      return { connection: conn, dispose: () => undefined };
    }
  });
  return {
    acp,
    client: () => {
      if (!captured) throw new Error("client not built yet — call request() first");
      return captured;
    }
  };
}

describe("AcpConnection — request() maps method strings to library calls", () => {
  it("routes standard ACP methods to the typed connection methods", async () => {
    const conn = stubConnection();
    const { acp } = makeConnection(conn);

    expect(await acp.request("initialize", { clientInfo: { name: "x" } })).toEqual({
      protocolVersion: 1
    });
    expect(conn.initialize).toHaveBeenCalledWith({ clientInfo: { name: "x" } });

    expect(await acp.request("session/new", { cwd: "/tmp" })).toEqual({ sessionId: "sess-1" });
    expect(conn.newSession).toHaveBeenCalledWith({ cwd: "/tmp" });

    await acp.request("session/prompt", { sessionId: "sess-1", prompt: [] });
    expect(conn.prompt).toHaveBeenCalledWith({ sessionId: "sess-1", prompt: [] });

    await acp.request("session/set_model", { sessionId: "sess-1", modelId: "m" });
    expect(conn.setSessionModel).toHaveBeenCalledWith({ sessionId: "sess-1", modelId: "m" });

    await acp.request("session/set_mode", { sessionId: "sess-1", modeId: "auto" });
    expect(conn.setSessionMode).toHaveBeenCalledWith({ sessionId: "sess-1", modeId: "auto" });
  });

  it("routes a non-standard method through the SDK's generic request()", async () => {
    const conn = stubConnection();
    const { acp } = makeConnection(conn);
    expect(await acp.request("session/set_config_option", { key: "k", value: "v" })).toEqual({
      ok: true
    });
    expect(conn.request).toHaveBeenCalledWith("session/set_config_option", { key: "k", value: "v" });
  });

  it("routes a non-standard notification through the SDK's generic notify()", async () => {
    const conn = stubConnection();
    const { acp } = makeConnection(conn);
    await acp.notify("session/vendor_notification", { sessionId: "sess-1" });
    expect(conn.notify).toHaveBeenCalledWith("session/vendor_notification", { sessionId: "sess-1" });
  });

  it("session/cancel goes to cancel() (request and notify)", async () => {
    const conn = stubConnection();
    const { acp } = makeConnection(conn);
    await acp.request("session/cancel", { sessionId: "sess-1" });
    await acp.notify("session/cancel", { sessionId: "sess-1" });
    expect(conn.cancel).toHaveBeenCalledTimes(2);
  });
});

describe("AcpConnection — bridges agent→client traffic to onNotification/onRequest", () => {
  it("emits session/update with the full notification payload", async () => {
    const conn = stubConnection();
    const { acp, client } = makeConnection(conn);
    const seen: Array<[string, unknown]> = [];
    acp.onNotification((method, params) => seen.push([method, params]));

    await acp.request("initialize", {}); // builds the client

    const notification = {
      sessionId: "sess-1",
      update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "hi" } }
    };
    await client().sessionUpdate(notification as never);

    expect(seen).toEqual([["session/update", notification]]);
  });

  it("preserves SDK 1.3 config updates and scalar tool raw output", async () => {
    const conn = stubConnection();
    const { acp, client } = makeConnection(conn);
    const seen: Array<[string, unknown]> = [];
    acp.onNotification((method, params) => seen.push([method, params]));
    await acp.request("initialize", {});

    const configUpdate = {
      sessionId: "sess-1",
      update: {
        sessionUpdate: "config_option_update",
        configOptions: [{ id: "thinking", currentValue: "off" }]
      }
    };
    const toolUpdate = {
      sessionId: "sess-1",
      update: { sessionUpdate: "tool_call_update", toolCallId: "tool-1", rawOutput: "plain text" }
    };
    await client().sessionUpdate(configUpdate as never);
    await client().sessionUpdate(toolUpdate as never);

    expect(seen).toEqual([
      ["session/update", configUpdate],
      ["session/update", toolUpdate]
    ]);
  });

  it("emits vendor notifications via extNotification under their own method name", async () => {
    const conn = stubConnection();
    const { acp, client } = makeConnection(conn);
    const seen: Array<[string, unknown]> = [];
    acp.onNotification((method, params) => seen.push([method, params]));

    await acp.request("initialize", {});
    await client().extNotification!("session_summary_generated", {
      sessionId: "sess-1",
      summary: "A title"
    });

    expect(seen).toEqual([
      ["session_summary_generated", { sessionId: "sess-1", summary: "A title" }]
    ]);
  });

  it("routes requestPermission to the registered onRequest handler and returns its result", async () => {
    const conn = stubConnection();
    const { acp, client } = makeConnection(conn);
    const decision = { outcome: { outcome: "selected", optionId: "allow" } };
    acp.onRequest(async (method, params) => {
      expect(method).toBe("session/request_permission");
      expect(params).toMatchObject({ sessionId: "sess-1" });
      return decision;
    });

    await acp.request("initialize", {});
    const result = await client().requestPermission({ sessionId: "sess-1" } as never);
    expect(result).toEqual(decision);
  });

  it("throws if requestPermission arrives with no handler registered", async () => {
    const conn = stubConnection();
    const { acp, client } = makeConnection(conn);
    await acp.request("initialize", {});
    await expect(client().requestPermission({ sessionId: "sess-1" } as never)).rejects.toThrow(
      /request handler unavailable/
    );
  });
});

describe.runIf(process.platform === "win32")("AcpConnection — Windows batch shim", () => {
  it("initializes over real ACP stdio without evaluating launch arguments", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "agent-acp-connection-win-"));
    const bin = path.join(root, "ACP & shims");
    const marker = path.join(root, "injected.txt");
    const script = path.join(bin, "fixture-agent.cjs");
    const shim = path.join(bin, "fixture-agent.cmd");
    const dangerousArgument = `acp & echo injected>"${marker}"`;
    mkdirSync(bin, { recursive: true });
    writeFileSync(script, `
const readline = require("node:readline");
const launchArg = process.argv[2];
const firstPathDir = (process.env.Path || process.env.PATH || "").split(";")[0];
const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method !== "initialize") return;
  process.stdout.write(JSON.stringify({
    jsonrpc: "2.0",
    id: message.id,
    result: {
      protocolVersion: message.params.protocolVersion,
      agentCapabilities: { loadSession: false },
      agentInfo: { name: "fixture-agent", version: launchArg, title: firstPathDir }
    }
  }) + "\\n");
});
`, "utf8");
    writeFileSync(
      shim,
      `@ECHO off\nSETLOCAL\nnode "%~dp0\\fixture-agent.cjs" %*\n`,
      "utf8"
    );
    const env = { ...process.env };
    for (const key of Object.keys(env)) {
      if (key.toLowerCase() === "path") delete env[key];
    }
    env.Path = path.dirname(process.execPath);
    const acp = new AcpConnection({ command: shim, args: [dangerousArgument], env });

    try {
      const result = await acp.request("initialize", {
        protocolVersion: 1,
        clientCapabilities: {},
        clientInfo: { name: "agent-kit-test", version: "1.0.0" }
      });
      expect(result).toMatchObject({
        protocolVersion: 1,
        agentInfo: { name: "fixture-agent", version: dangerousArgument, title: bin }
      });
      expect(existsSync(marker)).toBe(false);
    } finally {
      await acp.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
