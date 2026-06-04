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
    expect(events.some((e) => e.kind === "agent_message_delta" && e.delta === "routed")).toBe(true);
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
