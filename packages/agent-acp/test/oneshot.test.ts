import { describe, expect, it } from "vitest";
import { AcpOneShotClient } from "../src/acp-oneshot-client";
import {
  buildAcpBackendId,
  defaultQuirks,
  type AcpAgentStrategy
} from "../src/strategies/strategy-types";
import { FakeAcpAgentTransport } from "./fake-acp-agent";

const strategy: AcpAgentStrategy = {
  id: "gemini",
  backendId: buildAcpBackendId("gemini"),
  displayName: "Gemini CLI",
  authors: ["Google"],
  discoveryProbe: {
    command: "gemini",
    versionArgs: ["--version"],
    helpArgs: ["--help"],
    helpMatches: /--acp/
  },
  spawn: { command: "gemini", args: ["--experimental-acp"] },
  quirks: defaultQuirks()
};

/** Let the in-flight runInner reach the pending `session/prompt` before the
 *  test drives the fake. */
function tick(ms = 10): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("AcpOneShotClient", () => {
  it("runs one turn and returns the agent's final message text", async () => {
    const transport = new FakeAcpAgentTransport();
    const client = new AcpOneShotClient({ transport, strategy, now: () => 1 });

    const pending = client.run({ prompt: "Describe this. Reply with JSON only." });
    await tick();
    transport.emitSessionUpdate("session-1", {
      sessionUpdate: "agent_message_chunk",
      content: '```json\n{"caption":"a cat"}\n```'
    });
    transport.finishPrompt();

    const response = await pending;
    expect(response.rawText).toContain('"caption"');
    expect(response.threadId).toMatch(/^acp:gemini:/);
    expect(response.modelProvider).toBeTruthy();
    await client.close();
  });

  it("serializes concurrent runs (one turn at a time)", async () => {
    const transport = new FakeAcpAgentTransport();
    const client = new AcpOneShotClient({ transport, strategy, now: () => 1 });

    const first = client.run({ prompt: "one" });
    const second = client.run({ prompt: "two" });

    await tick();
    transport.emitSessionUpdate("session-1", {
      sessionUpdate: "agent_message_chunk",
      content: "first-done"
    });
    transport.finishPrompt();
    const r1 = await first;
    expect(r1.rawText).toBe("first-done");

    // The second run only starts after the first settles.
    await tick();
    transport.emitSessionUpdate("session-1", {
      sessionUpdate: "agent_message_chunk",
      content: "second-done"
    });
    transport.finishPrompt();
    const r2 = await second;
    expect(r2.rawText).toBe("second-done");
    await client.close();
  });

  it("reports token usage from the session/prompt response _meta.quota", async () => {
    const transport = new FakeAcpAgentTransport();
    const client = new AcpOneShotClient({ transport, strategy, now: () => 1 });
    const pending = client.run({ prompt: "x" });
    await tick();
    transport.emitSessionUpdate("session-1", {
      sessionUpdate: "agent_message_chunk",
      content: "ok"
    });
    transport.finishPrompt({
      stopReason: "end_turn",
      _meta: { quota: { token_count: { input_tokens: 100, output_tokens: 20 } } }
    });
    const response = await pending;
    expect(response.tokenUsage).toEqual({
      totalTokens: 120,
      inputTokens: 100,
      outputTokens: 20
    });
    await client.close();
  });

  it("reports OpenAI-dialect usage from the result root (Grok/xAI, Qwen)", async () => {
    const transport = new FakeAcpAgentTransport();
    const client = new AcpOneShotClient({ transport, strategy, now: () => 1 });
    const pending = client.run({ prompt: "x" });
    await tick();
    transport.emitSessionUpdate("session-1", { sessionUpdate: "agent_message_chunk", content: "ok" });
    transport.finishPrompt({
      stopReason: "end_turn",
      usage: {
        prompt_tokens: 300,
        completion_tokens: 40,
        total_tokens: 340,
        prompt_tokens_details: { cached_tokens: 128 },
        completion_tokens_details: { reasoning_tokens: 12 }
      }
    });
    const response = await pending;
    expect(response.tokenUsage).toEqual({
      totalTokens: 340,
      inputTokens: 300,
      outputTokens: 40,
      cachedInputTokens: 128,
      reasoningOutputTokens: 12
    });
    await client.close();
  });

  it("reports Anthropic-dialect usage nested under _meta", async () => {
    const transport = new FakeAcpAgentTransport();
    const client = new AcpOneShotClient({ transport, strategy, now: () => 1 });
    const pending = client.run({ prompt: "x" });
    await tick();
    transport.emitSessionUpdate("session-1", { sessionUpdate: "agent_message_chunk", content: "ok" });
    transport.finishPrompt({
      stopReason: "end_turn",
      _meta: { usage: { input_tokens: 50, output_tokens: 9, cache_read_input_tokens: 16 } }
    });
    const response = await pending;
    expect(response.tokenUsage).toEqual({
      totalTokens: 59,
      inputTokens: 50,
      outputTokens: 9,
      cachedInputTokens: 16
    });
    await client.close();
  });

  it("reports Grok/xAI usage from camelCase counts directly on _meta", async () => {
    const transport = new FakeAcpAgentTransport();
    const client = new AcpOneShotClient({ transport, strategy, now: () => 1 });
    const pending = client.run({ prompt: "x" });
    await tick();
    transport.emitSessionUpdate("session-1", { sessionUpdate: "agent_message_chunk", content: "ok" });
    transport.finishPrompt({
      stopReason: "end_turn",
      _meta: {
        totalTokens: 8200,
        inputTokens: 8000,
        outputTokens: 200,
        cachedReadTokens: 1024,
        reasoningTokens: 64
      }
    });
    const response = await pending;
    expect(response.tokenUsage).toEqual({
      totalTokens: 8200,
      inputTokens: 8000,
      outputTokens: 200,
      cachedInputTokens: 1024,
      reasoningOutputTokens: 64
    });
    await client.close();
  });

  it("returns null usage when the response carries no recognizable shape", async () => {
    const transport = new FakeAcpAgentTransport();
    const client = new AcpOneShotClient({ transport, strategy, now: () => 1 });
    const pending = client.run({ prompt: "x" });
    await tick();
    transport.emitSessionUpdate("session-1", { sessionUpdate: "agent_message_chunk", content: "ok" });
    transport.finishPrompt({ stopReason: "end_turn" });
    const response = await pending;
    expect(response.tokenUsage).toBeNull();
    await client.close();
  });

  it("listModels resolves to an array (empty when the agent advertises none)", async () => {
    const transport = new FakeAcpAgentTransport();
    const client = new AcpOneShotClient({ transport, strategy, now: () => 1 });
    const models = await client.listModels();
    expect(Array.isArray(models)).toBe(true);
    await client.close();
  });

  it("rejects before start when already aborted", async () => {
    const transport = new FakeAcpAgentTransport();
    const client = new AcpOneShotClient({ transport, strategy, now: () => 1 });
    const controller = new AbortController();
    controller.abort();
    await expect(
      client.run({ prompt: "x", abortSignal: controller.signal })
    ).rejects.toThrow(/aborted/);
    await client.close();
  });
});

describe("AcpAgentClient session cwd", () => {
  it("creates a non-existent session cwd before session/new (avoids agent -32603)", async () => {
    const { mkdtempSync, existsSync } = await import("node:fs");
    const os = await import("node:os");
    const nodePath = await import("node:path");
    const { AcpAgentClient } = await import("../src/acp-client");
    const { FakeAcpAgentTransport } = await import("./fake-acp-agent");
    const base = mkdtempSync(nodePath.join(os.tmpdir(), "acp-cwd-"));
    const cwd = nodePath.join(base, "deep", "session-dir");
    expect(existsSync(cwd)).toBe(false);
    const client = new AcpAgentClient({
      transport: new FakeAcpAgentTransport(),
      strategy,
      cwd,
      now: () => 1
    });
    await client.startThread();
    expect(existsSync(cwd)).toBe(true);
    await client.close();
  });
});
