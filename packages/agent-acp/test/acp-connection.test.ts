import { describe, expect, it, vi } from "vitest";
import { sessionNotificationSchema, type Client } from "@zed-industries/agent-client-protocol";
import {
  AcpConnection,
  sanitizeAcpNotificationLine,
  type AcpAgentConnection
} from "../src/acp-connection";

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
    extMethod: vi.fn(async () => ({ ok: true })),
    extNotification: vi.fn(async () => undefined),
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

  it("routes a non-standard method (session/set_config_option) through extMethod", async () => {
    const conn = stubConnection();
    const { acp } = makeConnection(conn);
    expect(await acp.request("session/set_config_option", { key: "k", value: "v" })).toEqual({
      ok: true
    });
    expect(conn.extMethod).toHaveBeenCalledWith("session/set_config_option", {
      key: "k",
      value: "v"
    });
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
  it("emits session/update with the full notification ({ sessionId, update })", async () => {
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

describe("sanitizeAcpNotificationLine", () => {
  // Regression: 0.9.0 adopted the official ACP library, which validates inbound
  // notifications. Its schema types tool_call(_update).rawInput/rawOutput as
  // z.record (a plain object), but Kimi sends rawOutput as a JSON STRING or
  // ARRAY — failing validation and dropping the whole session/update.
  const line = (update: Record<string, unknown>): string =>
    JSON.stringify({
      jsonrpc: "2.0",
      method: "session/update",
      params: { sessionId: "session_x", update }
    });
  const paramsOf = (raw: string): unknown => (JSON.parse(raw) as { params: unknown }).params;

  it("a Kimi-style string rawOutput FAILS the real library schema before sanitizing", () => {
    const params = paramsOf(
      line({
        sessionUpdate: "tool_call_update",
        toolCallId: "0:tool_x",
        status: "completed",
        rawOutput: '[{"id":"layer1","name":"AI arrow"}]'
      })
    );
    expect(sessionNotificationSchema.safeParse(params).success).toBe(false);
  });

  it("wraps a non-object rawOutput so it PASSES the real library schema", () => {
    for (const rawOutput of ['[{"id":"l1"}]', "a string", 42, true]) {
      const sanitized = sanitizeAcpNotificationLine(
        line({ sessionUpdate: "tool_call_update", toolCallId: "t", rawOutput })
      );
      expect(
        sessionNotificationSchema.safeParse(paramsOf(sanitized)).success,
        `rawOutput=${JSON.stringify(rawOutput)}`
      ).toBe(true);
      const out = (paramsOf(sanitized) as { update: { rawOutput: unknown } }).update.rawOutput;
      expect(out).toEqual({ value: rawOutput }); // data preserved
    }
  });

  it("wraps an ARRAY rawOutput (render_composite shape)", () => {
    const sanitized = sanitizeAcpNotificationLine(
      line({ sessionUpdate: "tool_call_update", toolCallId: "t", rawOutput: [{ a: 1 }, { b: 2 }] })
    );
    expect(sessionNotificationSchema.safeParse(paramsOf(sanitized)).success).toBe(true);
  });

  it("also fixes rawInput and the initial tool_call notification", () => {
    const sanitized = sanitizeAcpNotificationLine(
      line({ sessionUpdate: "tool_call", toolCallId: "t", title: "Call x", rawInput: "not-an-object" })
    );
    expect(sessionNotificationSchema.safeParse(paramsOf(sanitized)).success).toBe(true);
  });

  it("leaves a valid OBJECT rawInput untouched (normal tool args)", () => {
    const sanitized = sanitizeAcpNotificationLine(
      line({
        sessionUpdate: "tool_call_update",
        toolCallId: "t",
        rawInput: { capture_id: "r6qk", color: "#3b82f6" }
      })
    );
    const out = (paramsOf(sanitized) as { update: { rawInput: unknown } }).update.rawInput;
    expect(out).toEqual({ capture_id: "r6qk", color: "#3b82f6" });
  });

  it("drops an explicit null rawOutput (schema is optional, not nullable)", () => {
    const sanitized = sanitizeAcpNotificationLine(
      line({ sessionUpdate: "tool_call_update", toolCallId: "t", rawOutput: null })
    );
    const update = (paramsOf(sanitized) as { update: Record<string, unknown> }).update;
    expect("rawOutput" in update).toBe(false);
    expect(sessionNotificationSchema.safeParse(paramsOf(sanitized)).success).toBe(true);
  });

  it("passes through non-session/update lines and malformed JSON unchanged", () => {
    const other = JSON.stringify({ jsonrpc: "2.0", id: 1, result: { ok: true } });
    expect(sanitizeAcpNotificationLine(other)).toBe(other);
    expect(sanitizeAcpNotificationLine("not json at all")).toBe("not json at all");
    expect(sanitizeAcpNotificationLine("")).toBe("");
  });
});
