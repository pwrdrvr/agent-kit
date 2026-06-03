import { describe, it, expect } from "vitest";
import type {
  AgentMessageDeltaNotification,
  ItemCompletedNotification,
  ItemStartedNotification,
  ReasoningTextDeltaNotification,
  ThreadSettingsUpdatedNotification,
  ThreadTokenUsageUpdatedNotification,
  TurnCompletedNotification,
  TurnStartedNotification
} from "@pwrdrvr/codex-app-server-protocol/v2";
import type { NormalizedThreadEvent } from "@pwrdrvr/agent-core";
import {
  CODEX_NOTIFICATION_METHODS,
  normalizeNotification,
  normalizeTokenUsage
} from "../src/normalize";

const THREAD = "thread-1";
const TURN = "turn-1";

// A synthetic-but-realistic Codex v2 turn: started → reasoning → message deltas
// → a dynamic tool call (started, then completed) → token usage → final message
// → turn completed, plus a thread-settings update.
function syntheticSequence(): Array<{ method: string; params: unknown }> {
  const turnStarted: TurnStartedNotification = {
    threadId: THREAD,
    turn: {
      id: TURN,
      items: [],
      itemsView: "full" as never,
      status: "inProgress",
      error: null,
      startedAt: 1,
      completedAt: null,
      durationMs: null
    }
  };
  const reasoning: ReasoningTextDeltaNotification = {
    threadId: THREAD,
    turnId: TURN,
    itemId: "r1",
    delta: "thinking…",
    contentIndex: 0
  };
  const delta1: AgentMessageDeltaNotification = {
    threadId: THREAD,
    turnId: TURN,
    itemId: "m1",
    delta: "Hello"
  };
  const delta2: AgentMessageDeltaNotification = {
    threadId: THREAD,
    turnId: TURN,
    itemId: "m1",
    delta: " world"
  };
  const toolStarted: ItemStartedNotification = {
    threadId: THREAD,
    turnId: TURN,
    startedAtMs: 10,
    item: {
      type: "dynamicToolCall",
      id: "call-1",
      namespace: "host_tools",
      tool: "library_search",
      arguments: { query: "cats" } as never,
      status: "inProgress",
      contentItems: null,
      success: null,
      durationMs: null
    }
  };
  const toolCompleted: ItemCompletedNotification = {
    threadId: THREAD,
    turnId: TURN,
    completedAtMs: 20,
    item: {
      type: "dynamicToolCall",
      id: "call-1",
      namespace: "host_tools",
      tool: "library_search",
      arguments: { query: "cats" } as never,
      status: "completed",
      contentItems: [{ type: "inputText", text: "3 results" }],
      success: true,
      durationMs: 10
    }
  };
  const usage: ThreadTokenUsageUpdatedNotification = {
    threadId: THREAD,
    turnId: TURN,
    tokenUsage: {
      total: {
        totalTokens: 100,
        inputTokens: 60,
        cachedInputTokens: 10,
        outputTokens: 40,
        reasoningOutputTokens: 5
      },
      last: {
        totalTokens: 50,
        inputTokens: 30,
        cachedInputTokens: 5,
        outputTokens: 20,
        reasoningOutputTokens: 2
      },
      modelContextWindow: 200000
    }
  };
  const messageCompleted: ItemCompletedNotification = {
    threadId: THREAD,
    turnId: TURN,
    completedAtMs: 30,
    item: { type: "agentMessage", id: "m1", text: "Hello world", phase: null, memoryCitation: null }
  };
  const turnCompleted: TurnCompletedNotification = {
    threadId: THREAD,
    turn: {
      id: TURN,
      items: [],
      itemsView: "full" as never,
      status: "completed",
      error: null,
      startedAt: 1,
      completedAt: 2,
      durationMs: 1000
    }
  };
  const settings: ThreadSettingsUpdatedNotification = {
    threadId: THREAD,
    threadSettings: {
      cwd: "/tmp" as never,
      approvalPolicy: "never" as never,
      approvalsReviewer: "user" as never,
      sandboxPolicy: "readOnly" as never,
      activePermissionProfile: null,
      model: "gpt-5-codex",
      modelProvider: "openai",
      serviceTier: "default",
      effort: "medium" as never,
      summary: null,
      collaborationMode: "off" as never,
      personality: null
    }
  };

  return [
    { method: CODEX_NOTIFICATION_METHODS.turnStarted, params: turnStarted },
    { method: CODEX_NOTIFICATION_METHODS.reasoningTextDelta, params: reasoning },
    { method: CODEX_NOTIFICATION_METHODS.agentMessageDelta, params: delta1 },
    { method: CODEX_NOTIFICATION_METHODS.agentMessageDelta, params: delta2 },
    { method: CODEX_NOTIFICATION_METHODS.itemStarted, params: toolStarted },
    { method: CODEX_NOTIFICATION_METHODS.itemCompleted, params: toolCompleted },
    { method: CODEX_NOTIFICATION_METHODS.tokenUsage, params: usage },
    { method: CODEX_NOTIFICATION_METHODS.itemCompleted, params: messageCompleted },
    { method: CODEX_NOTIFICATION_METHODS.threadSettings, params: settings },
    { method: CODEX_NOTIFICATION_METHODS.turnCompleted, params: turnCompleted }
  ];
}

describe("normalizeNotification", () => {
  it("normalizes a full synthetic turn to the exact NormalizedThreadEvent sequence", () => {
    const events = syntheticSequence()
      .map(({ method, params }) => normalizeNotification(method, params))
      .filter((e): e is NormalizedThreadEvent => e !== null);

    const golden: NormalizedThreadEvent[] = [
      { kind: "turn_started", threadId: THREAD, turnId: TURN },
      { kind: "reasoning_delta", threadId: THREAD, turnId: TURN, itemId: "r1", delta: "thinking…" },
      { kind: "agent_message_delta", threadId: THREAD, turnId: TURN, itemId: "m1", delta: "Hello" },
      { kind: "agent_message_delta", threadId: THREAD, turnId: TURN, itemId: "m1", delta: " world" },
      {
        kind: "tool_call",
        threadId: THREAD,
        turnId: TURN,
        toolCall: {
          id: "call-1",
          name: "library_search",
          kind: "search",
          label: "library_search",
          status: "in_progress",
          args: { query: "cats" }
        }
      },
      {
        kind: "tool_call_update",
        threadId: THREAD,
        turnId: TURN,
        toolCall: {
          id: "call-1",
          name: "library_search",
          kind: "search",
          label: "library_search",
          status: "completed",
          args: { query: "cats" },
          result: "3 results"
        }
      },
      {
        kind: "token_usage",
        threadId: THREAD,
        turnId: TURN,
        usage: {
          inputTokens: 30,
          cachedInputTokens: 5,
          outputTokens: 20,
          reasoningOutputTokens: 2,
          totalTokens: 50,
          contextWindow: 200000
        }
      },
      {
        kind: "agent_message",
        threadId: THREAD,
        turnId: TURN,
        message: { id: "m1", role: "assistant", text: "Hello world" }
      },
      {
        kind: "thread_settings",
        settings: {
          threadId: THREAD,
          model: "gpt-5-codex",
          modelProvider: "openai",
          serviceTier: "default"
        }
      },
      { kind: "turn_completed", threadId: THREAD, turnId: TURN, status: "completed" }
    ];

    expect(events).toEqual(golden);
  });

  it("maps Codex ThreadTokenUsage (last breakdown) to NormalizedTokenUsage", () => {
    expect(
      normalizeTokenUsage({
        total: {
          totalTokens: 9,
          inputTokens: 9,
          cachedInputTokens: 9,
          outputTokens: 9,
          reasoningOutputTokens: 9
        },
        last: {
          totalTokens: 7,
          inputTokens: 4,
          cachedInputTokens: 1,
          outputTokens: 3,
          reasoningOutputTokens: 1
        },
        modelContextWindow: null
      })
    ).toEqual({
      inputTokens: 4,
      cachedInputTokens: 1,
      outputTokens: 3,
      reasoningOutputTokens: 1,
      totalTokens: 7
    });
  });

  it("returns null for unknown methods and non-tool items", () => {
    expect(normalizeNotification("totally/unknown", {})).toBeNull();
    const planItem: ItemCompletedNotification = {
      threadId: THREAD,
      turnId: TURN,
      completedAtMs: 1,
      item: { type: "plan", id: "p1", text: "a plan" }
    };
    expect(normalizeNotification(CODEX_NOTIFICATION_METHODS.itemCompleted, planItem)).toBeNull();
  });

  it("normalizes model/rerouted to a thread_settings event", () => {
    const event = normalizeNotification(CODEX_NOTIFICATION_METHODS.modelRerouted, {
      threadId: THREAD,
      turnId: TURN,
      fromModel: "gpt-5",
      toModel: "gpt-5-mini",
      reason: "fallback"
    });
    expect(event).toEqual({
      kind: "thread_settings",
      settings: { threadId: THREAD, model: "gpt-5-mini", modelProvider: "openai", serviceTier: null }
    });
  });
});
