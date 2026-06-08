import { describe, expect, it } from "vitest";
import type { AgentBackend, NormalizedThreadEvent } from "@pwrdrvr/agent-core";
import {
  normalizeAcpRuntimeCapabilities,
  acpSessionRuntimeStateFromUpdate,
  modelIdFromCapabilities,
  modelsFromCapabilities
} from "../src/normalizer/runtime-capabilities";
import { AcpAgentClient } from "../src/acp-client";
import { geminiStrategy } from "../src/strategies/index";
import { FakeAcpAgentTransport } from "./fake-acp-agent";

// A Kimi-style session/new payload: model + thinking exposed as configOptions,
// NOT as top-level `models` (which Kimi never advertises).
const KIMI_CONFIG_OPTIONS = {
  configOptions: [
    {
      type: "select",
      id: "model",
      name: "Model",
      category: "model",
      currentValue: "kimi-code/kimi-for-coding",
      options: [{ value: "kimi-code/kimi-for-coding", name: "Kimi-k2.6" }]
    },
    {
      type: "select",
      id: "thinking",
      name: "Thinking",
      category: "thought_level",
      currentValue: "on",
      options: [
        { value: "off", name: "Thinking Off" },
        { value: "on", name: "Thinking On" }
      ]
    }
  ]
};

describe("modelIdFromCapabilities / modelsFromCapabilities", () => {
  it("reads the effective model from a `model` configOption (Kimi)", () => {
    const caps = normalizeAcpRuntimeCapabilities({
      now: 1,
      source: "session-new",
      value: KIMI_CONFIG_OPTIONS
    });
    expect(caps?.models).toBeUndefined();
    expect(modelIdFromCapabilities(caps)).toBe("kimi-code/kimi-for-coding");
  });

  it("derives a model list (with label + isDefault) from the `model` configOption", () => {
    const caps = normalizeAcpRuntimeCapabilities({
      now: 1,
      source: "session-new",
      value: KIMI_CONFIG_OPTIONS
    });
    expect(modelsFromCapabilities(caps)).toEqual([
      { id: "kimi-code/kimi-for-coding", label: "Kimi-k2.6", isDefault: true }
    ]);
  });

  it("prefers top-level models when the agent advertises them (Gemini)", () => {
    const caps = normalizeAcpRuntimeCapabilities({
      now: 1,
      source: "session-new",
      value: { models: { availableModels: [{ id: "gemini-3-flash" }], currentModelId: "gemini-3-flash" } }
    });
    expect(modelIdFromCapabilities(caps)).toBe("gemini-3-flash");
    expect(modelsFromCapabilities(caps).map((m) => m.id)).toEqual(["gemini-3-flash"]);
  });

  it("returns undefined / [] when no model is advertised", () => {
    const caps = normalizeAcpRuntimeCapabilities({
      now: 1,
      source: "session-new",
      value: { modes: { availableModes: [{ id: "plan" }] } }
    });
    expect(modelIdFromCapabilities(caps)).toBeUndefined();
    expect(modelsFromCapabilities(caps)).toEqual([]);
  });
});

describe("normalizeAcpRuntimeCapabilities — merge over initialize", () => {
  it("reads models/modes camel + snake tolerantly", () => {
    const caps = normalizeAcpRuntimeCapabilities({
      now: 1,
      source: "initialize",
      value: {
        protocol_version: 1,
        models: {
          availableModels: [{ modelId: "fast", name: "Fast" }, { id: "smart" }],
          currentModelId: "fast"
        },
        modes: {
          availableModes: [{ id: "yolo", name: "YOLO" }],
          currentModeId: "yolo"
        }
      }
    });
    expect(caps?.protocolVersion).toBe(1);
    expect(caps?.models?.availableModels.map((m) => m.id)).toEqual(["fast", "smart"]);
    expect(caps?.models?.currentModelId).toBe("fast");
    expect(caps?.modes?.currentModeId).toBe("yolo");
  });

  it("flags the agent's current model as isDefault (and only that one)", () => {
    const caps = normalizeAcpRuntimeCapabilities({
      now: 1,
      source: "initialize",
      value: {
        models: {
          availableModels: [{ id: "fast" }, { id: "smart" }, { id: "turbo" }],
          currentModelId: "smart"
        }
      }
    });
    const byId = new Map(caps?.models?.availableModels.map((m) => [m.id, m]));
    expect(byId.get("smart")?.isDefault).toBe(true);
    expect(byId.get("fast")?.isDefault).toBeUndefined();
    expect(byId.get("turbo")?.isDefault).toBeUndefined();
  });

  it("flags no model when the agent advertises models but no currentModelId", () => {
    const caps = normalizeAcpRuntimeCapabilities({
      now: 1,
      source: "initialize",
      value: { models: { availableModels: [{ id: "fast" }, { id: "smart" }] } }
    });
    expect(caps?.models?.availableModels.every((m) => m.isDefault === undefined)).toBe(true);
  });

  it("a set_model mid-session merges over initialize without dropping prior modes", () => {
    const initialize = normalizeAcpRuntimeCapabilities({
      now: 1,
      source: "initialize",
      value: {
        models: { availableModels: [{ id: "fast" }, { id: "smart" }], currentModelId: "fast" },
        modes: { availableModes: [{ id: "plan" }, { id: "yolo" }], currentModeId: "plan" }
      }
    });
    // session/set_model response carries only the new model; modes must survive.
    const merged = normalizeAcpRuntimeCapabilities({
      now: 2,
      source: "session-load",
      ...(initialize !== undefined ? { initialize } : {}),
      value: { models: { availableModels: [{ id: "fast" }, { id: "smart" }], currentModelId: "smart" } }
    });
    expect(merged?.models?.currentModelId).toBe("smart");
    expect(merged?.modes?.availableModes.map((m) => m.id)).toEqual(["plan", "yolo"]);
    expect(merged?.modes?.currentModeId).toBe("plan");
  });

  it("extracts a runtime-state change from a config_option_update", () => {
    const state = acpSessionRuntimeStateFromUpdate(
      { sessionUpdate: "config_option_update", configOption: { id: "verbosity", value: "high" } },
      5
    );
    expect(state).toEqual({ configValues: { verbosity: "high" }, updatedAt: 5 });
  });
});

describe("AcpAgentClient — thread_settings emission", () => {
  it("emits thread_settings carrying model + mode (id + label) after a set", async () => {
    const transport = new FakeAcpAgentTransport({
      // initialize advertises a mode catalog so the label resolves.
      initialize: {
        protocolVersion: 1,
        modes: { availableModes: [{ id: "yolo", name: "YOLO mode" }], currentModeId: "plan" }
      },
      "session/set_mode": {}
    });
    const client = new AcpAgentClient({ transport, strategy: geminiStrategy, now: () => 1 });
    const { threadId } = await client.startThread();

    const settings: NormalizedThreadEvent[] = [];
    client.onEvent((e) => {
      if (e.kind === "thread_settings") settings.push(e);
    });

    await client.setMode(threadId, "yolo");
    const last = settings.at(-1);
    expect(last).toMatchObject({
      kind: "thread_settings",
      settings: { threadId, modeId: "yolo", modeLabel: "YOLO mode", modelProvider: "gemini" }
    });
  });
});

describe("AcpAgentClient conforms to AgentBackend", () => {
  it("is assignable to AgentBackend and exposes the full surface", () => {
    const transport = new FakeAcpAgentTransport();
    const client = new AcpAgentClient({ transport, strategy: geminiStrategy });
    // Compile-time conformance: assign to the neutral interface.
    const backend: AgentBackend = client;
    expect(typeof backend.startThread).toBe("function");
    expect(typeof backend.startTurn).toBe("function");
    expect(typeof backend.interruptTurn).toBe("function");
    expect(typeof backend.onEvent).toBe("function");
    expect(typeof backend.onToolCall).toBe("function");
    expect(typeof backend.onApprovalRequest).toBe("function");
    expect(typeof backend.close).toBe("function");
  });
});
