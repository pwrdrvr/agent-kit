import { describe, expect, it } from "vitest";
import type { NormalizedThreadEvent } from "@pwrdrvr/agent-core";
import {
  AcpSessionNormalizer,
  type AcpApplyContext
} from "../src/normalizer/acp-normalizer";
import { defaultQuirks } from "../src/strategies/strategy-types";
import { geminiStrategy, grokStrategy, qwenStrategy } from "../src/strategies/index";

const CTX: AcpApplyContext = { threadId: "acp:gemini:1", turnId: "turn-1" };

function gemini(): AcpSessionNormalizer {
  return new AcpSessionNormalizer({ quirks: geminiStrategy.quirks });
}

function applyAll(
  normalizer: AcpSessionNormalizer,
  updates: Record<string, unknown>[],
  ctx: AcpApplyContext = CTX
): NormalizedThreadEvent[] {
  return updates.flatMap((update) => normalizer.apply(update, ctx).events);
}

describe("AcpSessionNormalizer — message chunk coalescing", () => {
  it("coalesces consecutive agent_message_chunks into one bubble (one itemId)", () => {
    const normalizer = gemini();
    const events = applyAll(normalizer, [
      { kind: "agent_message_chunk", content: "Hello " },
      { kind: "agent_message_chunk", content: "world" }
    ]);
    expect(events).toEqual([
      {
        kind: "agent_message_delta",
        threadId: CTX.threadId,
        turnId: CTX.turnId,
        itemId: "assistant:turn-1:0",
        delta: "Hello "
      },
      {
        kind: "agent_message_delta",
        threadId: CTX.threadId,
        turnId: CTX.turnId,
        itemId: "assistant:turn-1:0",
        delta: "world"
      }
    ]);
    // The finalized message reflects the coalesced text.
    const final = normalizer.finalizeAssistantMessage(CTX);
    expect(final).toEqual([
      {
        kind: "agent_message",
        threadId: CTX.threadId,
        turnId: CTX.turnId,
        message: { id: "assistant:turn-1:0", role: "assistant", text: "Hello world" }
      }
    ]);
  });

  it("splits a new bubble when text follows a tool call", () => {
    const normalizer = gemini();
    const events = applyAll(normalizer, [
      { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Working." } },
      { sessionUpdate: "tool_call", toolCallId: "t1", title: "cat package.json", status: "completed" },
      { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Done." } }
    ]);
    const itemIds = events
      .filter((e): e is Extract<NormalizedThreadEvent, { kind: "agent_message_delta" }> =>
        e.kind === "agent_message_delta")
      .map((e) => e.itemId);
    // Two distinct bubbles around the tool call.
    expect(new Set(itemIds).size).toBe(2);
    expect(itemIds).toEqual(["assistant:turn-1:0", "assistant:turn-1:1"]);
  });

  it("reads nested ACP text content blocks", () => {
    const normalizer = gemini();
    const events = applyAll(normalizer, [
      { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "OK." } }
    ]);
    expect(events[0]).toMatchObject({ kind: "agent_message_delta", delta: "OK." });
  });

  it("unwraps deeply nested content blocks", () => {
    const normalizer = gemini();
    const events = applyAll(normalizer, [
      {
        sessionUpdate: "agent_message_chunk",
        content: [{ type: "content", content: { type: "text", text: "Deeply nested." } }]
      }
    ]);
    expect(events[0]).toMatchObject({ delta: "Deeply nested." });
  });

  it("does not render Gemini mode marker chunks as assistant text", () => {
    const normalizer = gemini();
    const events = applyAll(normalizer, [
      { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "[MODE_UPDATE] yolo" } }
    ]);
    expect(events).toEqual([]);
  });
});

describe("AcpSessionNormalizer — camel/snake parity", () => {
  const fields: Array<[string, Record<string, unknown>]> = [
    ["camelCase sessionUpdate", { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Hi." } }],
    ["snake_case session_update", { session_update: "agent_message_chunk", content: { type: "text", text: "Hi." } }],
    ["bare kind", { kind: "agent_message_chunk", text: "Hi." }]
  ];

  it.each(fields)("normalizes %s identically", (_label, update) => {
    const events = applyAll(gemini(), [update]);
    expect(events).toEqual([
      {
        kind: "agent_message_delta",
        threadId: CTX.threadId,
        turnId: CTX.turnId,
        itemId: "assistant:turn-1:0",
        delta: "Hi."
      }
    ]);
  });

  it("merges snake_case tool_call/tool_call_update with camelCase identically", () => {
    const snake = applyAll(gemini(), [
      { session_update: "tool_call", tool_call_id: "t1", title: "pnpm build", status: "in_progress" },
      { session_update: "tool_call_update", tool_call_id: "t1", status: "completed", content: { type: "text", text: "ok" } }
    ]);
    const camel = applyAll(gemini(), [
      { sessionUpdate: "tool_call", toolCallId: "t1", title: "pnpm build", status: "in_progress" },
      { sessionUpdate: "tool_call_update", toolCallId: "t1", status: "completed", content: { type: "text", text: "ok" } }
    ]);
    expect(snake).toEqual(camel);
    expect(camel[0]).toMatchObject({ kind: "tool_call", toolCall: { id: "t1", status: "in_progress" } });
    expect(camel[1]).toMatchObject({ kind: "tool_call_update", toolCall: { id: "t1", status: "completed" } });
  });
});

describe("AcpSessionNormalizer — tool calls", () => {
  it("infers kind read/write/command and emits a tool_call", () => {
    const events = applyAll(gemini(), [
      { sessionUpdate: "tool_call", toolCallId: "r1", kind: "read", title: "README.md", status: "completed", locations: [{ path: "/repo/README.md" }] }
    ]);
    expect(events[0]).toMatchObject({
      kind: "tool_call",
      toolCall: { id: "r1", kind: "read", label: "README.md", status: "completed" }
    });
  });

  it("infers command kind and fills command output on a merged update", () => {
    const events = applyAll(gemini(), [
      { sessionUpdate: "tool_call", toolCallId: "run-pwd", kind: "execute", title: "pwd", status: "pending", command: "pwd" },
      { sessionUpdate: "tool_call_update", toolCallId: "run-pwd", kind: "execute", status: "completed", output: "/repo\n", exitCode: 0 }
    ]);
    expect(events[1]).toMatchObject({
      kind: "tool_call_update",
      toolCall: {
        id: "run-pwd",
        kind: "command",
        label: "pwd",
        status: "completed",
        command: { displayCommand: "pwd", rawCommand: "pwd", output: "/repo\n", exitCode: 0 }
      }
    });
  });

  it.each(["rawInput", "raw_input"])("keeps the Antigravity summary from %s through completion", (inputKey) => {
    const script = "printf '%s\\n' 'checking fixture'\nprintf '%s\\n' 'done'";
    const events = applyAll(gemini(), [
      {
        sessionUpdate: "tool_call",
        toolCallId: "run-command",
        kind: "execute",
        name: "run_command",
        title: script,
        [inputKey]: { CommandLine: script, toolSummary: "Check the fixture" }
      },
      {
        sessionUpdate: "tool_call_update",
        toolCallId: "run-command",
        title: script,
        status: "completed",
        output: "done\n",
        exitCode: 0
      }
    ]);

    expect(events[0]).toMatchObject({
      toolCall: {
        label: "Check the fixture",
        kind: "command",
        command: { displayCommand: script, rawCommand: script }
      }
    });
    expect(events[1]).toMatchObject({
      kind: "tool_call_update",
      toolCall: {
        label: "Check the fixture",
        kind: "command",
        status: "completed",
        command: { displayCommand: script, rawCommand: script, output: "done\n", exitCode: 0 }
      }
    });
  });

  it.each(["/bin/zsh -lc", "/bin/sh -c"])("compares the script title with a %s wrapper", (wrapper) => {
    const script = 'echo "done"';
    const command = `${wrapper} '${script}'`;
    const events = applyAll(gemini(), [
      {
        sessionUpdate: "tool_call",
        toolCallId: "run-command",
        kind: "execute",
        title: 'echo   "done"',
        command
      }
    ]);

    expect(events[0]).toMatchObject({
      toolCall: {
        label: script,
        command: { displayCommand: command, rawCommand: command }
      }
    });
  });

  it.each([
    { command: "bash -c 'echo \"$1\"' _ 'hello'" },
    { command: 'bash -c "echo $1" _ "hello"' },
    { command: "/bin/bash -C ./build.sh" },
    { command: '/bin/bash -c ""' },
    { command: "/bin/bash -c ' \t '", label: "/bin/bash -c ' '" }
  ])("keeps the invocation in the label for $command", ({ command, label = command }) => {
    const [event] = applyAll(gemini(), [
      { sessionUpdate: "tool_call", toolCallId: "command", kind: "execute", title: "Bash", command }
    ]);

    expect(event).toMatchObject({
      toolCall: { label, command: { displayCommand: command, rawCommand: command } }
    });
  });

  it("shows one line for a double-quoted script with escaped quotes", () => {
    const command = '/bin/bash -c "echo \\"first\\"\necho second"';
    const [event] = applyAll(gemini(), [
      { sessionUpdate: "tool_call", toolCallId: "command", kind: "execute", title: "Bash", command }
    ]);

    expect(event).toMatchObject({
      toolCall: {
        label: 'echo \\"first\\" echo second',
        command: { displayCommand: command, rawCommand: command }
      }
    });
  });

  it("keeps leading whitespace and a trailing escaped space in command details", () => {
    const command = "  printf '%s' fixture\\ ";
    const [event] = applyAll(gemini(), [
      { sessionUpdate: "tool_call", toolCallId: "command", kind: "execute", title: "Bash", command }
    ]);
    expect(event).toMatchObject({
      toolCall: { command: { displayCommand: command, rawCommand: command } }
    });
  });

  it.each(["run", "execute"])("shortens the command when the title is %s", (title) => {
    const command = `echo ${"a".repeat(80)}\necho done`;
    const [event] = applyAll(gemini(), [
      { sessionUpdate: "tool_call", toolCallId: "command", kind: "execute", title, command }
    ]);
    expect(event).toMatchObject({
      toolCall: { label: `echo ${"a".repeat(64)}...` }
    });
  });

  it.each(["read", "search"])("keeps a command-shaped argument as input for a %s tool", (kind) => {
    const args = { command: "printf", description: "Look up command documentation" };
    const [event] = applyAll(gemini(), [
      { sessionUpdate: "tool_call", toolCallId: "docs", kind, title: "Shell manual", rawInput: args }
    ]);
    expect(event).toMatchObject({ toolCall: { kind, label: "Shell manual", args } });
    expect(event).not.toHaveProperty("toolCall.command");
  });

  it("reconciles a generic later label against a specific earlier one", () => {
    const events = applyAll(gemini(), [
      { sessionUpdate: "tool_call", toolCallId: "t1", kind: "execute", title: "pnpm build", status: "in_progress" },
      { sessionUpdate: "tool_call_update", toolCallId: "t1", title: "run", status: "completed" }
    ]);
    // "run" is generic → the specific "pnpm build" label wins.
    expect(events[1]).toMatchObject({ toolCall: { label: "pnpm build", status: "completed" } });
  });

  it("maps unknown tool names to kind other", () => {
    const events = applyAll(gemini(), [
      { sessionUpdate: "tool_call", toolCallId: "x1", title: "frobnicate", status: "in_progress" }
    ]);
    expect(events[0]).toMatchObject({ toolCall: { kind: "other" } });
  });

  it("extracts nested tool update content as the read RESULT, not a fake command (issue #1)", () => {
    const events = applyAll(gemini(), [
      { sessionUpdate: "tool_call", toolCallId: "r1", kind: "read", title: "README.md", status: "in_progress" },
      {
        sessionUpdate: "tool_call_update",
        toolCallId: "r1",
        kind: "read",
        title: "README.md",
        status: "completed",
        content: [{ type: "content", content: { type: "text", text: "Read lines 1-80" } }]
      }
    ]);
    expect(events[1]).toMatchObject({ toolCall: { kind: "read", result: "Read lines 1-80" } });
    // A read's content is its result — it must NOT be fabricated into a command.
    const tc = (events[1] as { toolCall: { command?: unknown } }).toolCall;
    expect(tc.command).toBeUndefined();
  });

  it("preserves a read tool's file path via locations, with no command (issue #1)", () => {
    const events = applyAll(gemini(), [
      {
        sessionUpdate: "tool_call",
        toolCallId: "read-1",
        kind: "read",
        title: "README.md",
        status: "completed",
        locations: [{ path: "/repo/README.md", line: 12 }]
      }
    ]);
    expect(events[0]).toMatchObject({
      toolCall: {
        kind: "read",
        label: "README.md",
        status: "completed",
        locations: [{ path: "/repo/README.md", line: 12 }]
      }
    });
    const tc = (events[0] as { toolCall: { command?: unknown } }).toolCall;
    expect(tc.command).toBeUndefined();
  });

  it("a genuine command tool still gets command detail (output + exitCode)", () => {
    const events = applyAll(gemini(), [
      {
        sessionUpdate: "tool_call",
        toolCallId: "c1",
        kind: "execute",
        title: "ls -la",
        command: "ls -la",
        status: "completed",
        content: [{ type: "content", content: { type: "text", text: "file1\nfile2" } }]
      }
    ]);
    expect(events[0]).toMatchObject({
      toolCall: {
        kind: "command",
        command: { displayCommand: "ls -la", rawCommand: "ls -la", output: "file1\nfile2" }
      }
    });
  });
});

describe("AcpSessionNormalizer — plans", () => {
  it("emits a plan_update", () => {
    const events = applyAll(gemini(), [
      { kind: "plan", steps: [{ step: "Inspect files", status: "in_progress" }] }
    ]);
    expect(events[0]).toMatchObject({
      kind: "plan_update",
      plan: { steps: [{ step: "Inspect files", status: "in_progress" }] }
    });
  });
});

describe("AcpSessionNormalizer — thought suppression via strategy", () => {
  it("surfaces thought chunks as reasoning_delta when the strategy allows (Gemini)", () => {
    const events = applyAll(gemini(), [
      { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "Thinking…" } }
    ]);
    expect(events).toEqual([
      {
        kind: "reasoning_delta",
        threadId: CTX.threadId,
        turnId: CTX.turnId,
        itemId: "assistant:turn-1:0",
        delta: "Thinking…"
      }
    ]);
  });

  it("suppresses thought chunks when the strategy says so (Qwen)", () => {
    const normalizer = new AcpSessionNormalizer({ quirks: qwenStrategy.quirks });
    const events = applyAll(normalizer, [
      { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "Thinking…" } }
    ]);
    expect(events).toEqual([]);
  });
});

describe("AcpSessionNormalizer — title extraction via strategy", () => {
  it("extracts a topic-update title (Gemini) without emitting a transcript event", () => {
    const result = gemini().apply(
      { sessionUpdate: "tool_call", kind: "think", title: 'Update topic to: "Exploring PwrSnap"', status: "completed" },
      CTX
    );
    expect(result.title).toBe("Exploring PwrSnap");
    expect(result.events).toEqual([]);
  });

  it("extracts Grok session_summary_generated as a title (camel + snake)", () => {
    const grok = new AcpSessionNormalizer({ quirks: grokStrategy.quirks });
    expect(
      grok.apply({ sessionUpdate: "session_summary_generated", session_summary: "Haiku About Debugging" }, CTX).title
    ).toBe("Haiku About Debugging");
    expect(
      grok.apply({ sessionUpdate: "session_summary_generated", sessionSummary: "Refactor toolchain" }, CTX).title
    ).toBe("Refactor toolchain");
    expect(
      grok.apply({ sessionUpdate: "session_summary_generated", session_summary: "   " }, CTX).title
    ).toBeUndefined();
  });

  it("does not treat a Grok summary as a title under a topic-only strategy", () => {
    // A topic-update strategy ignores session_summary_generated entirely.
    const topicOnly = new AcpSessionNormalizer({ quirks: defaultQuirks({ titleFrom: "topic-update" }) });
    const result = topicOnly.apply(
      { sessionUpdate: "session_summary_generated", session_summary: "Some title" },
      CTX
    );
    expect(result.title).toBeUndefined();
  });
});

describe("AcpSessionNormalizer — turn ordering", () => {
  it("keeps two turns' bubbles in durable order", () => {
    const normalizer = gemini();
    const ctx1: AcpApplyContext = { threadId: "acp:gemini:1", turnId: "turn-1" };
    const ctx2: AcpApplyContext = { threadId: "acp:gemini:1", turnId: "turn-2" };

    normalizer.resetTurn();
    normalizer.apply({ sessionUpdate: "agent_message_chunk", content: "It is PwrSnap." }, ctx1);
    const final1 = normalizer.finalizeAssistantMessage(ctx1);
    normalizer.resetTurn();
    normalizer.apply({ sessionUpdate: "agent_message_chunk", content: "/repo/project" }, ctx2);
    const final2 = normalizer.finalizeAssistantMessage(ctx2);

    expect(final1[0]).toMatchObject({ message: { text: "It is PwrSnap." }, turnId: "turn-1" });
    expect(final2[0]).toMatchObject({ message: { text: "/repo/project" }, turnId: "turn-2" });
  });
});

describe("AcpSessionNormalizer — runtime/metadata updates are not transcript noise", () => {
  it("drops available_commands_update and mode/config updates", () => {
    const events = applyAll(gemini(), [
      { sessionUpdate: "available_commands_update", availableCommands: [{ name: "help" }] },
      { sessionUpdate: "current_mode_update", currentModeId: "yolo" },
      { kind: "future_unknown_update" }
    ]);
    expect(events).toEqual([]);
  });
});
