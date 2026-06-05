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
