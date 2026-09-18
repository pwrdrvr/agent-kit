import { describe, expect, it } from "vitest";
import type { NormalizedThreadEvent } from "@pwrdrvr/agent-core";
import { AcpAgentClient } from "../src/acp-client";
import { kimiStrategy } from "../src/strategies/index";
import { FakeAcpAgentTransport } from "./fake-acp-agent";

const K27 = "kimi-code/kimi-for-coding";
const K3 = "kimi-code/k3";

/** Kimi Code CLI 2.0.0's measured thought levels: the model DECIDES the menu. */
function thinkingLevels(model: string): string[] {
  return model === K3 ? ["low", "high", "max", "on"] : ["on"];
}

function kimiConfigOptions(model: string, thinking = "on"): Record<string, unknown>[] {
  return [
    {
      type: "select",
      id: "model",
      name: "Model",
      category: "model",
      currentValue: model,
      options: [
        { value: K27, name: "K2.7 Coding" },
        { value: K3, name: "K3" }
      ]
    },
    {
      type: "select",
      id: "thinking",
      name: "Thinking",
      category: "thought_level",
      currentValue: thinking,
      options: thinkingLevels(model).map((value) => ({ value, name: value }))
    }
  ];
}

/** A Kimi-shaped agent: each session has its own model, and a thought level its
 *  model does not offer is refused — as the real CLI refuses it. */
class KimiLikeTransport extends FakeAcpAgentTransport {
  private sessionCount = 0;
  private readonly sessionModels = new Map<string, string>();

  override async request(
    method: string,
    params?: Record<string, unknown>,
    timeoutMs?: number
  ): Promise<unknown> {
    if (method === "session/new") {
      await super.request(method, params, timeoutMs);
      const sessionId = `session-${++this.sessionCount}`;
      this.sessionModels.set(sessionId, K27);
      return { sessionId, configOptions: kimiConfigOptions(K27) };
    }
    if (method === "session/set_config_option") {
      await super.request(method, params, timeoutMs);
      const sessionId = String(params?.sessionId);
      const value = String(params?.value);
      if (params?.configId === "model") {
        this.sessionModels.set(sessionId, value);
        return { configOptions: kimiConfigOptions(value) };
      }
      const model = this.sessionModels.get(sessionId) ?? K27;
      if (!thinkingLevels(model).includes(value)) {
        throw new Error(`thinking "${value}" is not offered by ${model}`);
      }
      return { configOptions: kimiConfigOptions(model, value) };
    }
    return await super.request(method, params, timeoutMs);
  }
}

function thinkingWrites(transport: FakeAcpAgentTransport): Array<Record<string, unknown>> {
  return transport.requests
    .filter((r) => r.method === "session/set_config_option" && r.params?.configId === "thinking")
    .map((r) => r.params ?? {});
}

async function startLowTurn(
  client: AcpAgentClient,
  transport: FakeAcpAgentTransport,
  threadId: string
): Promise<void> {
  await client.startTurn({ threadId, input: { text: "describe" }, reasoning: "low" });
  transport.finishPrompt();
}

describe("one pooled client, sessions on different models", () => {
  it("maps reasoning against the session's own thought levels, not the last session opened", async () => {
    const transport = new KimiLikeTransport();
    const client = new AcpAgentClient({ transport, strategy: kimiStrategy });

    const enrichment = await client.startThread({ model: K3 }); // session-1, low offered
    await client.startThread(); // session-2 opens on K2.7 — [on] only

    await startLowTurn(client, transport, enrichment.threadId);

    // Read from the client-wide snapshot, this saw session-2's [on] menu and
    // sent nothing: K3 ran with thinking on.
    expect(thinkingWrites(transport)).toEqual([
      { sessionId: "session-1", configId: "thinking", value: "low" }
    ]);
  });

  it("does not send a thought level the session's own model lacks", async () => {
    const transport = new KimiLikeTransport();
    const client = new AcpAgentClient({ transport, strategy: kimiStrategy });

    const chat = await client.startThread(); // session-1 on K2.7 — [on] only
    await client.startThread({ model: K3 }); // session-2 — client-wide menu now K3's

    await startLowTurn(client, transport, chat.threadId);

    // Read from the client-wide snapshot, this sent thinking=low to a K2.7
    // session, which the agent refuses.
    expect(thinkingWrites(transport)).toEqual([]);
  });

  it("refreshes a session's menus from a full-set config_option_update", async () => {
    const transport = new KimiLikeTransport();
    const client = new AcpAgentClient({ transport, strategy: kimiStrategy });
    const thread = await client.startThread(); // K2.7 — [on] only

    // The ACP 1.3 shape: the WHOLE option set, as Kimi emits after a model change.
    transport.emitSessionUpdate("session-1", {
      sessionUpdate: "config_option_update",
      configOptions: kimiConfigOptions(K3)
    });
    await startLowTurn(client, transport, thread.threadId);

    expect(thinkingWrites(transport)).toEqual([
      { sessionId: "session-1", configId: "thinking", value: "low" }
    ]);
  });

  it("reports the model a full-set config_option_update carries", async () => {
    const transport = new KimiLikeTransport();
    const client = new AcpAgentClient({ transport, strategy: kimiStrategy });
    const models: Array<string | undefined> = [];
    client.onEvent((event: NormalizedThreadEvent) => {
      if (event.kind === "thread_settings") models.push(event.settings.model);
    });
    await client.startThread({ model: K27 });

    transport.emitSessionUpdate("session-1", {
      sessionUpdate: "config_option_update",
      configOptions: kimiConfigOptions(K3)
    });

    // The earlier write recorded currentModelId=K27; the agent's own report of
    // the new model must win, not the stale request.
    expect(models.at(-1)).toBe(K3);
  });
});
