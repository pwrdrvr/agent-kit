// The crown jewel: fold the messy, inconsistent ACP `session/update` stream into
// agent-core's neutral `NormalizedThreadEvent` — the SAME shapes the Codex
// adapter emits, so a consumer is backend-agnostic.
//
// Ported from PwrAgnt acp-session-normalizer.ts, re-targeted off its
// AppServerThreadReplay onto agent-core NormalizedThreadEvent. Preserves:
//   • camel/snake tolerance on every field (via ./content readers);
//   • recursive content unwrap (readAcpContentText);
//   • agent_message_chunk coalescing — consecutive chunks merge into one
//     message bubble (one itemId); text AFTER a tool call splits a new bubble;
//   • tool_call → tool_call_update merge via agent-core mergeToolCall /
//     preferSpecificLabel, kind inference via inferToolKind;
//   • per-agent behaviors (suppress thoughts, topic→title) read from the
//     STRATEGY's quirks — NO inline per-agent-id branch ever appears here.
//
// Stateful per session: one normalizer instance per ACP session, holding the
// active assistant/thought message ids (for coalescing) and prior tool calls
// (for delta merge + label reconciliation).

import {
  mergeToolCall,
  preferSpecificLabel,
  type NormalizedMessage,
  type NormalizedPlan,
  type NormalizedPlanStep,
  type NormalizedThreadEvent,
  type NormalizedToolCall
} from "@pwrdrvr/agent-core";
import type { AcpAgentQuirks } from "../strategies/strategy-types";
import {
  asRecord,
  readContentText,
  readFirstString,
  readKind,
  readString,
  readUpdateText
} from "./content";
import { toolCallFromUpdate } from "./tool-activity";

export type AcpNormalizerOptions = {
  /** The agent's normalization quirks (surface thoughts, where title comes from). */
  quirks: AcpAgentQuirks;
};

export type AcpNormalizeResult = {
  events: NormalizedThreadEvent[];
  /** A thread title extracted from a topic-update / session-summary, if any. */
  title?: string;
};

export type AcpApplyContext = {
  threadId: string;
  turnId: string;
};

const EMPTY_RESULT: AcpNormalizeResult = { events: [] };

export class AcpSessionNormalizer {
  private readonly quirks: AcpAgentQuirks;

  // Coalescing state. One "live" assistant message bubble at a time; a tool
  // call (or any non-text update) clears it so the next text starts a new one.
  private activeAssistantItemId: string | undefined;
  private assistantText = "";
  private assistantSequence = 0;

  // Tool-call merge state: id → last fully-merged NormalizedToolCall, so a
  // tool_call_update reconciles labels / fills command output against it.
  private readonly toolCalls = new Map<string, NormalizedToolCall>();

  constructor(options: AcpNormalizerOptions) {
    this.quirks = options.quirks;
  }

  /** Reset coalescing state at a turn boundary (new prompt / turn finished). */
  resetTurn(): void {
    this.activeAssistantItemId = undefined;
    this.assistantText = "";
  }

  /** Finalize the in-flight assistant bubble into a terminal `agent_message`, if any. */
  finalizeAssistantMessage(ctx: AcpApplyContext): NormalizedThreadEvent[] {
    if (this.activeAssistantItemId === undefined || this.assistantText === "") {
      this.resetTurn();
      return [];
    }
    const message: NormalizedMessage = {
      id: this.activeAssistantItemId,
      role: "assistant",
      text: this.assistantText
    };
    this.resetTurn();
    return [
      {
        kind: "agent_message",
        threadId: ctx.threadId,
        turnId: ctx.turnId,
        message
      }
    ];
  }

  /** Normalize one ACP session/update into neutral events (+ optional title). */
  apply(update: Record<string, unknown>, ctx: AcpApplyContext): AcpNormalizeResult {
    const kind = readKind(update);

    // 1) Title-bearing updates (topic-update / vendor session-summary). Strategy
    //    quirks decide which spellings count. Never a transcript event.
    const title = this.extractTitle(update, kind);
    if (title !== undefined) {
      return { events: [], title };
    }

    switch (kind) {
      case "agent_message_chunk":
        return { events: this.applyAgentMessageChunk(update, ctx) };
      case "agent_thought_chunk":
        return { events: this.applyThoughtChunk(update, ctx) };
      case "user_message_chunk":
        return { events: this.applyUserMessageChunk(update, ctx) };
      case "plan":
        this.activeAssistantItemId = undefined;
        return { events: this.applyPlan(update, ctx) };
      case "tool_call":
      case "tool_call_update":
      case "file":
      case "terminal":
        this.activeAssistantItemId = undefined;
        return { events: this.applyToolCall(update, kind, ctx) };
      case "available_commands_update":
      case "current_mode_update":
      case "config_option_update":
        // Runtime metadata, not transcript — the client handles these via
        // runtime-capabilities and emits thread_settings itself.
        return EMPTY_RESULT;
      default:
        // Unknown update: no transcript noise. (PwrAgnt surfaced an "unknown
        // activity" entry; in the event model we simply drop it — a consumer
        // that wants raw access can subscribe to the transport observer.)
        this.activeAssistantItemId = undefined;
        return EMPTY_RESULT;
    }
  }

  private applyAgentMessageChunk(
    update: Record<string, unknown>,
    ctx: AcpApplyContext
  ): NormalizedThreadEvent[] {
    const text = readUpdateText(update) ?? "";
    if (text === "" || isModeUpdateMarker(text)) {
      return [];
    }
    const itemId = this.assistantItemIdForChunk(update, ctx);
    this.assistantText = appendTranscriptChunk(this.assistantText, text);
    return [
      {
        kind: "agent_message_delta",
        threadId: ctx.threadId,
        turnId: ctx.turnId,
        itemId,
        delta: text
      }
    ];
  }

  private applyThoughtChunk(
    update: Record<string, unknown>,
    ctx: AcpApplyContext
  ): NormalizedThreadEvent[] {
    if (!this.quirks.surfaceThoughts) {
      return [];
    }
    const text = readUpdateText(update) ?? "";
    if (text === "") {
      return [];
    }
    // Thoughts coalesce into the same live bubble as message chunks (matching
    // PwrAgnt, which surfaced thoughts as assistant text). In the neutral schema
    // they ride the `reasoning_delta` channel so a consumer can style them.
    const itemId = this.assistantItemIdForChunk(update, ctx);
    this.assistantText = appendTranscriptChunk(this.assistantText, text);
    return [
      {
        kind: "reasoning_delta",
        threadId: ctx.threadId,
        turnId: ctx.turnId,
        itemId,
        delta: text
      }
    ];
  }

  private applyUserMessageChunk(
    update: Record<string, unknown>,
    ctx: AcpApplyContext
  ): NormalizedThreadEvent[] {
    this.activeAssistantItemId = undefined;
    const text = readUpdateText(update) ?? "";
    if (text === "") {
      return [];
    }
    const id =
      readFirstString(update, "messageId", "message_id", "id") ??
      `user:${ctx.threadId}:${ctx.turnId}`;
    const message: NormalizedMessage = { id, role: "user", text };
    return [
      {
        kind: "agent_message",
        threadId: ctx.threadId,
        turnId: ctx.turnId,
        message
      }
    ];
  }

  private applyPlan(
    update: Record<string, unknown>,
    ctx: AcpApplyContext
  ): NormalizedThreadEvent[] {
    const id = readString(update, "planId") ?? `plan:${ctx.threadId}`;
    const plan: NormalizedPlan = {
      id,
      steps: readPlanSteps(update)
    };
    const explanation = readString(update, "explanation");
    if (explanation !== undefined) plan.explanation = explanation;
    const markdown = readString(update, "markdown");
    if (markdown !== undefined) plan.markdown = markdown;
    return [{ kind: "plan_update", threadId: ctx.threadId, turnId: ctx.turnId, plan }];
  }

  private applyToolCall(
    update: Record<string, unknown>,
    kind: string,
    ctx: AcpApplyContext
  ): NormalizedThreadEvent[] {
    const incoming = toolCallFromUpdate(update, kind, ctx.threadId);
    const prev = this.toolCalls.get(incoming.id);
    if (prev === undefined) {
      this.toolCalls.set(incoming.id, incoming);
      return [
        { kind: "tool_call", threadId: ctx.threadId, turnId: ctx.turnId, toolCall: incoming }
      ];
    }
    // Subsequent update: merge via agent-core (label reconciliation, command
    // detail fill, later-status-wins) and emit a tool_call_update delta.
    const merged = mergeToolCall(prev, incoming);
    // agent-core merges command detail shallowly (later displayCommand wins);
    // reconcile it with the same prefer-specific rule the label uses, so a
    // later output-only update keeps the earlier specific displayCommand.
    if (merged.command && prev.command) {
      merged.command = {
        ...merged.command,
        displayCommand: preferSpecificLabel(
          prev.command.displayCommand,
          merged.command.displayCommand
        )
      };
    }
    this.toolCalls.set(incoming.id, merged);
    return [
      {
        kind: "tool_call_update",
        threadId: ctx.threadId,
        turnId: ctx.turnId,
        toolCall: merged
      }
    ];
  }

  private assistantItemIdForChunk(
    update: Record<string, unknown>,
    ctx: AcpApplyContext
  ): string {
    const explicitId = readFirstString(update, "messageId", "message_id");
    if (explicitId) {
      if (explicitId !== this.activeAssistantItemId) {
        this.activeAssistantItemId = explicitId;
        this.assistantText = "";
      }
      return explicitId;
    }
    if (this.activeAssistantItemId === undefined) {
      this.activeAssistantItemId = `assistant:${ctx.turnId}:${this.assistantSequence++}`;
      this.assistantText = "";
    }
    return this.activeAssistantItemId;
  }

  /** Strategy-driven title extraction. NO agent-id literal — reads quirks.titleFrom. */
  private extractTitle(
    update: Record<string, unknown>,
    kind: string
  ): string | undefined {
    const wantsSummary =
      this.quirks.titleFrom === "session-summary" || this.quirks.titleFrom === "both";
    const wantsTopic =
      this.quirks.titleFrom === "topic-update" || this.quirks.titleFrom === "both";

    if (wantsSummary && kind === "session_summary_generated") {
      const summary = (
        readString(update, "session_summary") ?? readString(update, "sessionSummary")
      )?.trim();
      return summary || undefined;
    }

    if (wantsTopic) {
      const isToolish =
        kind === "tool_call" || kind === "tool_call_update" || kind === "think";
      if (!isToolish) {
        return undefined;
      }
      const titleText = readString(update, "title")?.trim();
      if (!titleText) {
        return undefined;
      }
      const quoted = /^Update topic to:\s*["“](.+?)["”]\s*$/iu.exec(titleText);
      const fallback = /^Update topic to:\s*(.+)$/iu.exec(titleText);
      const topic = (quoted?.[1] ?? fallback?.[1])?.trim();
      return topic || undefined;
    }

    return undefined;
  }
}

// Consecutive ACP text chunks concatenate, but a markdown heading / bold lead
// that starts a new block gets a paragraph break so bubbles read correctly.
function appendTranscriptChunk(existing: string, next: string): string {
  if (!existing || !next) {
    return `${existing}${next}`;
  }
  if (shouldSeparateTranscriptChunks(existing, next)) {
    return `${existing}\n\n${next}`;
  }
  return `${existing}${next}`;
}

function shouldSeparateTranscriptChunks(existing: string, next: string): boolean {
  if (/\s$/.test(existing)) {
    return false;
  }
  return /^(?:#{1,6}\s|\*\*[^*]+?\*\*(?:\s|$))/.test(next);
}

function isModeUpdateMarker(text: string): boolean {
  return /^\[MODE_UPDATE\]\s*[A-Za-z0-9_-]+\s*$/.test(text.trim());
}

function readPlanSteps(record: Record<string, unknown>): NormalizedPlanStep[] {
  const steps = Array.isArray(record.steps) ? record.steps : [];
  return steps.flatMap((step): NormalizedPlanStep[] => {
    if (typeof step === "string") {
      return [{ step, status: "pending" }];
    }
    const stepRecord = asRecord(step);
    if (!stepRecord) {
      return [];
    }
    const text = readString(stepRecord, "step") ?? readString(stepRecord, "content");
    if (!text) {
      return [];
    }
    const status = readString(stepRecord, "status");
    return [
      {
        step: text,
        status: status === "in_progress" || status === "completed" ? status : "pending"
      }
    ];
  });
}

/** Read the message parts (text/image) of a prompt, camel/snake tolerant. */
export function readPromptText(content: unknown): string | undefined {
  return readContentText({ content }, "content");
}
