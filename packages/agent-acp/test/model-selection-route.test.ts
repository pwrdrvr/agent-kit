import { describe, expect, it } from "vitest";
import { AcpAgentClient } from "../src/acp-client";
import { geminiStrategy, kimiStrategy } from "../src/strategies/index";
import { FakeAcpAgentTransport } from "./fake-acp-agent";

/** Kimi Code CLI 0.29.2's REAL `session/new` result, trimmed to the model bits.
 *  Note what is NOT here: any `models` capability. Kimi exposes model choice
 *  ONLY as a config option, which is also the shape ACP 1.3 standardized on —
 *  `session/set_model` is absent from the SDK's `AGENT_METHODS` entirely. */
const KIMI_SESSION_NEW = {
  sessionId: "session-1",
  configOptions: [
    {
      type: "select",
      id: "model",
      name: "Model",
      category: "model",
      currentValue: "kimi-code/kimi-for-coding",
      options: [
        { value: "kimi-code/kimi-for-coding", name: "K2.7 Coding" },
        { value: "kimi-code/k3", name: "K3" }
      ]
    }
  ]
};

/** The older shape: an agent that advertises a first-class `models` capability. */
const LEGACY_SESSION_NEW = {
  sessionId: "session-1",
  models: {
    currentModelId: "gemini-2.5-flash",
    availableModels: [{ id: "gemini-2.5-flash" }, { id: "gemini-2.5-pro" }]
  }
};

function modelWrites(transport: FakeAcpAgentTransport): Array<{
  method: string;
  params?: Record<string, unknown>;
}> {
  return transport.requests.filter(
    (r) => r.method === "session/set_config_option" || r.method === "session/set_model"
  );
}

describe("model selection routes by how the agent advertises it", () => {
  it("sends a config-option write for an agent that has no models capability", async () => {
    const transport = new FakeAcpAgentTransport({
      "session/new": KIMI_SESSION_NEW,
      "session/set_config_option": {}
    });
    const client = new AcpAgentClient({ transport, strategy: kimiStrategy });

    const result = await client.startThread({ model: "kimi-code/k3" });

    expect(modelWrites(transport)).toEqual([
      {
        method: "session/set_config_option",
        params: { sessionId: "session-1", configId: "model", value: "kimi-code/k3" }
      }
    ]);
    // The selection applied, so the EFFECTIVE model is the requested one — not
    // the `currentValue` the session opened with.
    expect(result.model).toBe("kimi-code/k3");
  });

  it("still uses session/set_model for an agent that advertises availableModels", async () => {
    const transport = new FakeAcpAgentTransport({
      "session/new": LEGACY_SESSION_NEW,
      "session/set_model": {}
    });
    const client = new AcpAgentClient({ transport, strategy: geminiStrategy });

    await client.startThread({ model: "gemini-2.5-pro" });

    expect(modelWrites(transport)).toEqual([
      {
        method: "session/set_model",
        params: { sessionId: "session-1", modelId: "gemini-2.5-pro" }
      }
    ]);
  });

  it("reports the agent's own model when the config-option write is refused", async () => {
    const transport = new FakeAcpAgentTransport({
      "session/new": KIMI_SESSION_NEW,
      "session/set_config_option": new Error("unknown model: kimi-code/nope")
    });
    const client = new AcpAgentClient({ transport, strategy: kimiStrategy });

    const result = await client.startThread({ model: "kimi-code/nope" });

    // A refused write must NOT be reported as applied — the session is still on
    // whatever the agent opened with.
    expect(result.model).toBe("kimi-code/kimi-for-coding");
  });

  it("emits thread_settings carrying the model a config-option write selected", async () => {
    const transport = new FakeAcpAgentTransport({
      "session/new": KIMI_SESSION_NEW,
      "session/set_config_option": {}
    });
    const client = new AcpAgentClient({ transport, strategy: kimiStrategy });
    const models: Array<string | undefined> = [];
    client.onEvent((event) => {
      if (event.kind === "thread_settings") models.push(event.settings.model);
    });

    await client.startThread({ model: "kimi-code/k3" });

    // A consumer reading `settings.model` must not have to know which route the
    // agent happened to expose.
    expect(models.at(-1)).toBe("kimi-code/k3");
  });
});
