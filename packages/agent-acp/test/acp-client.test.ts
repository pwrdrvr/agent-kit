import { describe, expect, it } from "vitest";
import type {
  NormalizedApprovalDecision,
  NormalizedThreadEvent
} from "@pwrdrvr/agent-core";
import { AcpAgentClient } from "../src/acp-client";
import { geminiStrategy, grokStrategy } from "../src/strategies/index";
import { FakeAcpAgentTransport } from "./fake-acp-agent";

function makeClient(transport: FakeAcpAgentTransport, strategy = geminiStrategy): AcpAgentClient {
  let clock = 1000;
  return new AcpAgentClient({
    transport,
    strategy,
    now: () => clock++
  });
}

/** `startTurn` resolves at turn START and streams the terminal events
 *  (agent_message, token_usage, turn_completed) asynchronously when the faked
 *  `session/prompt` settles via `finishPrompt()`. Flush a macrotask so those
 *  background emits land before assertions. */
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe("AcpAgentClient — lifecycle", () => {
  it("initialize → session/new → session/prompt round-trips", async () => {
    const transport = new FakeAcpAgentTransport();
    const client = makeClient(transport);

    const { threadId } = await client.startThread({ cwd: "/repo" });
    expect(threadId).toMatch(/^acp:gemini:/);

    const events: NormalizedThreadEvent[] = [];
    client.onEvent((event) => events.push(event));

    const turnPromise = client.startTurn({ threadId, input: { text: "hello" } });
    // The agent streams an assistant chunk, then the prompt resolves.
    transport.emitSessionUpdate("session-1", {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "Hi there." }
    });
    transport.finishPrompt();
    await turnPromise;
    await flush();

    // ACP verbs sent in order.
    expect(transport.requests.map((r) => r.method)).toEqual([
      "initialize",
      "session/new",
      "session/prompt"
    ]);
    const init = transport.requests[0]?.params;
    expect(init).toMatchObject({ protocolVersion: 1, clientInfo: { name: "agent-kit" } });

    // turn_started → agent_message_delta → agent_message (finalized) → turn_completed
    const kinds = events.map((e) => e.kind);
    expect(kinds).toEqual([
      "turn_started",
      "agent_message_delta",
      "agent_message",
      "turn_completed"
    ]);
    const final = events.find((e) => e.kind === "agent_message");
    expect(final).toMatchObject({ message: { role: "assistant", text: "Hi there." } });
    const completed = events.find((e) => e.kind === "turn_completed");
    expect(completed).toMatchObject({ status: "completed" });
  });

  it("mints globally-unique thread ids across client instances (no acp:gemini:1 collision)", async () => {
    // Two separate clients (e.g. two app runs, or two chat surfaces) must not
    // both produce `acp:gemini:1` — that collided on a host's UNIQUE thread id.
    const a = new AcpAgentClient({ transport: new FakeAcpAgentTransport(), strategy: geminiStrategy, now: () => 1 });
    const b = new AcpAgentClient({ transport: new FakeAcpAgentTransport(), strategy: geminiStrategy, now: () => 1 });
    const a1 = (await a.startThread()).threadId;
    const a2 = (await a.startThread()).threadId;
    const b1 = (await b.startThread()).threadId;
    expect(new Set([a1, a2, b1]).size).toBe(3); // all distinct
    expect(a1).not.toBe("acp:gemini:1");
    // acp:<strategy>:<uuid> — a host-minted UUID, not a counter.
    const UUID = /^acp:gemini:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
    expect(a1).toMatch(UUID);
    expect(a2).toMatch(UUID);
    expect(b1).toMatch(UUID);
    await a.close();
    await b.close();
  });

  it("serializes mcpServers to the ACP wire shape (env array + required args)", async () => {
    const transport = new FakeAcpAgentTransport();
    const client = new AcpAgentClient({
      transport,
      strategy: geminiStrategy,
      now: () => 1,
      mcpServers: [
        {
          name: "pwrsnap",
          command: "/path/to/electron",
          env: { TOKEN: "abc", SOCKET: "/tmp/x.sock" }
        }
      ]
    });
    await client.startThread();
    const sessionNew = transport.requests.find((r) => r.method === "session/new");
    const servers = (sessionNew?.params as { mcpServers: unknown[] }).mcpServers as Array<{
      name: string;
      command: string;
      args: unknown;
      env: unknown;
    }>;
    expect(servers[0]).toEqual({
      name: "pwrsnap",
      command: "/path/to/electron",
      args: [], // required by ACP even when the host omits it
      env: [
        { name: "TOKEN", value: "abc" },
        { name: "SOCKET", value: "/tmp/x.sock" }
      ]
    });
  });

  it("folds startThread instructions into the FIRST turn prompt, once", async () => {
    const transport = new FakeAcpAgentTransport();
    const client = makeClient(transport);
    const { threadId } = await client.startThread({
      cwd: "/repo",
      instructions: "SYSTEM: you are PwrSnap's editor assistant."
    });

    // First turn: prompt is [instructions block, user text].
    await client.startTurn({ threadId, input: { text: "delete the arrow" } });
    transport.finishPrompt();
    await flush();
    const firstPrompt = transport.requests.filter((r) => r.method === "session/prompt")[0]
      ?.params as { prompt: Array<{ type: string; text: string }> };
    expect(firstPrompt.prompt.map((b) => b.text)).toEqual([
      "SYSTEM: you are PwrSnap's editor assistant.",
      "delete the arrow"
    ]);

    // Second turn: instructions are NOT repeated (the session already has them).
    await client.startTurn({ threadId, input: { text: "now make it blue" } });
    transport.finishPrompt();
    await flush();
    const secondPrompt = transport.requests.filter((r) => r.method === "session/prompt")[1]
      ?.params as { prompt: Array<{ type: string; text: string }> };
    expect(secondPrompt.prompt.map((b) => b.text)).toEqual(["now make it blue"]);
  });

  it("surfaces session/request_permission to the registered approval handler", async () => {
    const transport = new FakeAcpAgentTransport();
    const client = makeClient(transport);
    const { threadId } = await client.startThread();

    const approvals: NormalizedThreadEvent[] = [];
    client.onEvent((event) => {
      if (event.kind === "approval_request") approvals.push(event);
    });

    let seenMethod: string | undefined;
    client.onApprovalRequest(async (method): Promise<NormalizedApprovalDecision> => {
      seenMethod = method;
      return "approved";
    });

    const outcome = await transport.emitRequest(
      "session/request_permission",
      {
        sessionId: "session-1",
        toolCall: { toolCallId: "t1", title: "rm -rf build", kind: "execute" },
        options: [
          { optionId: "allow", name: "Allow", kind: "allow_once" },
          { optionId: "deny", name: "Reject", kind: "reject_once" }
        ]
      },
      "req-1"
    );

    expect(seenMethod).toBe("session/request_permission");
    expect(outcome).toEqual({ outcome: { outcome: "selected", optionId: "allow" } });
    expect(approvals[0]).toMatchObject({
      kind: "approval_request",
      threadId,
      approval: { method: "session/request_permission", kind: "exec", summary: "execute: rm -rf build" }
    });
  });

  it("maps a denied decision to the reject option", async () => {
    const transport = new FakeAcpAgentTransport();
    const client = makeClient(transport);
    await client.startThread();
    client.onApprovalRequest(async (): Promise<NormalizedApprovalDecision> => "denied");

    const outcome = await transport.emitRequest("session/request_permission", {
      sessionId: "session-1",
      toolCall: { toolCallId: "t1", title: "edit", kind: "edit" },
      options: [
        { optionId: "allow", kind: "allow_once" },
        { optionId: "deny", kind: "reject_once" }
      ]
    });
    expect(outcome).toEqual({ outcome: { outcome: "selected", optionId: "deny" } });
  });

  it("createDeferredThread mints an id WITHOUT spawning a session (instant new chat)", async () => {
    const transport = new FakeAcpAgentTransport();
    const client = makeClient(transport);
    const { threadId } = await client.createDeferredThread();
    expect(threadId).toMatch(/^acp:gemini:[0-9a-f-]+$/);
    // No agent spawn / session/new yet — deferred to the first turn.
    expect(transport.requests.filter((r) => r.method === "session/new")).toHaveLength(0);

    // The first turn (via reopenThread, as the chat controller does) establishes
    // the session bound to that deferred id.
    await client.reopenThread({ threadId, buildInstructions: () => "SYS" });
    expect(transport.requests.filter((r) => r.method === "session/new")).toHaveLength(1);
    await client.startTurn({ threadId, input: { text: "hi" } });
    transport.finishPrompt();
    await flush();
    await client.close();
  });

  it("reopenThread rebinds a fresh session to a persisted thread id (resume after restart)", async () => {
    const transport = new FakeAcpAgentTransport({
      "session/new": { sessionId: "11111111-1111-1111-1111-111111111111" }
    });
    const client = makeClient(transport);
    // A thread persisted from a previous run — this fresh client has no session
    // for it (the agent process, and its session, died with the old run).
    const persisted = "acp:gemini:52765539-723e-4955-8330-c3daa0322b72";
    await client.reopenThread({ threadId: persisted, buildInstructions: () => "SYSTEM PROMPT" });

    // A turn on that thread now works (no "Unknown ACP thread") and the first
    // prompt carries the re-applied system prompt.
    await client.startTurn({ threadId: persisted, input: { text: "continue" } });
    transport.finishPrompt();
    await flush();
    const prompt = transport.requests.filter((r) => r.method === "session/prompt")[0]
      ?.params as { prompt: Array<{ text: string }> };
    expect(prompt.prompt.map((b) => b.text)).toEqual(["SYSTEM PROMPT", "continue"]);
    await client.close();
  });

  it("reopenThread passes per-thread mcpServers to session/new (shared client, per-surface tools)", async () => {
    const transport = new FakeAcpAgentTransport();
    const client = makeClient(transport);
    await client.reopenThread({
      threadId: "acp:gemini:lib-thread",
      mcpServers: [{ name: "pwrsnap-library", command: "/x", env: { TOK: "lib" } }]
    });
    const sessionNew = transport.requests.find((r) => r.method === "session/new");
    const servers = (sessionNew?.params as {
      mcpServers: Array<{ name: string; env: Array<{ name: string; value: string }> }>;
    }).mcpServers;
    expect(servers[0]?.name).toBe("pwrsnap-library");
    expect(servers[0]?.env).toEqual([{ name: "TOK", value: "lib" }]);
    await client.close();
  });

  it("reopenThread is a no-op when the session is already live", async () => {
    const transport = new FakeAcpAgentTransport();
    const client = makeClient(transport);
    const { threadId } = await client.startThread();
    const before = transport.requests.filter((r) => r.method === "session/new").length;
    await client.reopenThread({ threadId });
    const after = transport.requests.filter((r) => r.method === "session/new").length;
    expect(after).toBe(before);
    await client.close();
  });

  it("uses the agent's session GUID as the thread id when it is a UUID", async () => {
    const uuid = "836a1942-8a8e-4c8d-9744-497242519df5";
    const transport = new FakeAcpAgentTransport({ "session/new": { sessionId: uuid } });
    const client = makeClient(transport);
    const { threadId } = await client.startThread();
    expect(threadId).toBe(`acp:gemini:${uuid}`);
    await client.close();
  });

  it("forwards a permission request to the host handler with the configured mcpServerNames", async () => {
    // The client makes NO trust decision of its own. It hands the host handler
    // the context the raw ACP params lack — the configured `mcpServerNames` —
    // so the HOST can decide to pre-approve a tool from a server it wired up.
    const transport = new FakeAcpAgentTransport();
    const client = new AcpAgentClient({
      transport,
      strategy: geminiStrategy,
      now: () => 1,
      mcpServers: [{ name: "pwrsnap", command: "/x" }]
    });
    await client.startThread();
    let seen: Record<string, unknown> | undefined;
    client.onApprovalRequest(async (_method, params) => {
      seen = params as Record<string, unknown>;
      return "approved";
    });
    const outcome = await transport.emitRequest(
      "session/request_permission",
      {
        sessionId: "session-1",
        toolCall: {
          toolCallId: "mcp_pwrsnap_read_ocr_text__1",
          title: "read_ocr_text (pwrsnap MCP Server)",
          kind: "other"
        },
        options: [
          { optionId: "proceed_always_server", name: "Allow all server tools", kind: "allow_always" },
          { optionId: "proceed_once", name: "Allow", kind: "allow_once" },
          { optionId: "cancel", name: "Reject", kind: "reject_once" }
        ]
      },
      "req-mcp"
    );
    // Host saw the configured server names so it can recognize its own tool.
    expect(seen?.mcpServerNames).toEqual(["pwrsnap"]);
    // An "approved" decision picks the BROADEST allow (session-wide server),
    // so the host isn't re-prompted on every call this session.
    expect(outcome).toEqual({
      outcome: { outcome: "selected", optionId: "proceed_always_server" }
    });
    await client.close();
  });

  it("passes PER-THREAD mcpServers to the handler when the client has no default (pooled client)", async () => {
    const transport = new FakeAcpAgentTransport();
    const client = new AcpAgentClient({
      transport,
      strategy: geminiStrategy,
      now: () => 1
      // NO client-level mcpServers — a shared/pooled client attaches tools
      // per-thread instead.
    });
    // Establish a session with PER-THREAD mcpServers, as the chat controller does.
    await client.reopenThread({
      threadId: "acp:gemini:pooled-1",
      mcpServers: [{ name: "pwrsnap", command: "/x" }]
    });
    let seen: Record<string, unknown> | undefined;
    client.onApprovalRequest(async (_method, params) => {
      seen = params as Record<string, unknown>;
      return "approved";
    });
    const outcome = await transport.emitRequest(
      "session/request_permission",
      {
        sessionId: "session-1",
        toolCall: {
          toolCallId: "mcp_pwrsnap_render_composite__1",
          title: "render_composite (pwrsnap MCP Server)",
          kind: "other"
        },
        options: [
          { optionId: "proceed_always_server", name: "Allow all server tools", kind: "allow_always" },
          { optionId: "cancel", name: "Reject", kind: "reject_once" }
        ]
      },
      "req-pooled"
    );
    // Per-thread server names reach the host even with no client-level default.
    expect(seen?.mcpServerNames).toEqual(["pwrsnap"]);
    expect(outcome).toEqual({
      outcome: { outcome: "selected", optionId: "proceed_always_server" }
    });
    await client.close();
  });

  it("routes a permission request to the handler with a resolved threadId", async () => {
    const transport = new FakeAcpAgentTransport();
    const client = new AcpAgentClient({
      transport,
      strategy: geminiStrategy,
      now: () => 1,
      mcpServers: [{ name: "pwrsnap", command: "/x" }]
    });
    const { threadId } = await client.startThread();
    let seen: Record<string, unknown> | undefined;
    client.onApprovalRequest(async (_method, params) => {
      seen = params as Record<string, unknown>;
      return "denied";
    });
    await transport.emitRequest(
      "session/request_permission",
      {
        sessionId: "session-1",
        toolCall: { toolCallId: "shell_1", title: "Run shell command", kind: "execute" },
        options: [
          { optionId: "allow", kind: "allow_once" },
          { optionId: "deny", kind: "reject_once" }
        ]
      },
      "req-shell"
    );
    expect(seen).toBeDefined();
    // The host handler gets the RESOLVED threadId injected (raw ACP params only
    // carry sessionId), so it can route even with multiple turns in flight.
    expect(seen?.threadId).toBe(threadId);
    await client.close();
  });

  it("cancels a permission request when no host handler is registered", async () => {
    const transport = new FakeAcpAgentTransport();
    const client = new AcpAgentClient({
      transport,
      strategy: geminiStrategy,
      now: () => 1,
      mcpServers: [{ name: "pwrsnap", command: "/x" }]
    });
    await client.startThread();
    // No onApprovalRequest handler registered (e.g. a pooled client whose host
    // forgot to wire one) — nothing can decide, so the request is cancelled.
    const outcome = await transport.emitRequest(
      "session/request_permission",
      {
        sessionId: "session-1",
        toolCall: { toolCallId: "mcp_pwrsnap_read_ocr_text__1", title: "x", kind: "other" },
        options: [{ optionId: "allow", kind: "allow_once" }]
      },
      "req-nohandler"
    );
    expect(outcome).toEqual({ outcome: { outcome: "cancelled" } });
    await client.close();
  });

  it("session/cancel terminates an in-flight prompt", async () => {
    const transport = new FakeAcpAgentTransport();
    const client = makeClient(transport);
    const { threadId } = await client.startThread();

    const turnPromise = client.startTurn({ threadId, input: { text: "long task" } });
    expect(transport.hasPendingPrompt()).toBe(true);

    await client.interruptTurn(threadId);
    await turnPromise; // resolves because cancel resolved the pending prompt

    expect(transport.notifications.map((n) => n.method)).toContain("session/cancel");
  });

  it("parses a snake_case session/new response (session_id)", async () => {
    const transport = new FakeAcpAgentTransport({ "session/new": { session_id: "snake-session" } });
    const client = makeClient(transport);
    const { threadId } = await client.startThread();
    // Subsequent session/update keyed on the snake_case id routes correctly.
    const events: NormalizedThreadEvent[] = [];
    client.onEvent((e) => events.push(e));
    const turn = client.startTurn({ threadId, input: { text: "x" } });
    transport.emitSessionUpdate("snake-session", {
      session_update: "agent_message_chunk",
      content: { type: "text", text: "routed" }
    });
    transport.finishPrompt();
    await turn;
    await flush();
    expect(events.some((e) => e.kind === "agent_message_delta" && e.delta === "routed")).toBe(true);
  });

  it("resolves startTurn at turn START, before turn_completed (non-blocking)", async () => {
    const transport = new FakeAcpAgentTransport();
    const client = makeClient(transport);
    const { threadId } = await client.startThread();

    const order: string[] = [];
    client.onEvent((event) => {
      if (event.kind === "turn_completed") order.push("turn_completed");
    });

    await client.startTurn({ threadId, input: { text: "hi" } });
    // startTurn has resolved but the prompt has NOT been finished — so the turn
    // is still in flight and turn_completed has not fired. This is the property
    // that keeps a chat composer from freezing for the whole turn.
    order.push("startTurn_resolved");
    expect(transport.hasPendingPrompt()).toBe(true);
    expect(order).toEqual(["startTurn_resolved"]);

    transport.finishPrompt();
    await flush();
    expect(order).toEqual(["startTurn_resolved", "turn_completed"]);
  });

  it("streams a failed turn_completed + error when the prompt rejects (no throw from startTurn)", async () => {
    const transport = new FakeAcpAgentTransport();
    const client = makeClient(transport);
    const { threadId } = await client.startThread();

    const events: NormalizedThreadEvent[] = [];
    client.onEvent((event) => events.push(event));

    // startTurn resolves even though the turn will fail — the failure arrives
    // asynchronously as events, not as a startTurn rejection.
    await expect(
      client.startTurn({ threadId, input: { text: "boom" } })
    ).resolves.toMatchObject({ turnId: expect.any(String) });

    transport.failPrompt(new Error("agent exploded"));
    await flush();

    const completed = events.find((e) => e.kind === "turn_completed");
    expect(completed).toMatchObject({ status: "failed" });
    const error = events.find((e) => e.kind === "error");
    expect(error).toMatchObject({ message: expect.stringContaining("agent exploded") });
  });

  it("routes Grok's vendor notification through the same path and emits a title", async () => {
    const transport = new FakeAcpAgentTransport();
    const client = makeClient(transport, grokStrategy);
    const { threadId } = await client.startThread();

    const titles: Array<{ threadId: string; title: string }> = [];
    client.onTitle((event) => titles.push(event));

    transport.emitVendorNotification({
      method: "_x.ai/session_notification",
      sessionId: "session-1",
      update: { sessionUpdate: "session_summary_generated", session_summary: "Debugging Haiku" }
    });

    expect(titles).toEqual([{ threadId, title: "Debugging Haiku" }]);
  });

  it("rejects a second concurrent turn on the same thread", async () => {
    const transport = new FakeAcpAgentTransport();
    const client = makeClient(transport);
    const { threadId } = await client.startThread();
    const turn = client.startTurn({ threadId, input: { text: "first" } });
    await expect(client.startTurn({ threadId, input: { text: "second" } })).rejects.toThrow(
      /already active/
    );
    transport.finishPrompt();
    await turn;
  });

  it("close() tears down subscriptions and closes the transport", async () => {
    const transport = new FakeAcpAgentTransport();
    const client = makeClient(transport);
    await client.startThread();
    await client.close();
    expect(transport.closeCount).toBe(1);
  });
});
