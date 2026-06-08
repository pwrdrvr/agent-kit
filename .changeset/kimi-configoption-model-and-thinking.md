---
"@pwrdrvr/agent-acp": minor
---

ACP: support agents that expose model + thinking as `configOptions` (Kimi)

Kimi Code CLI advertises its model and reasoning controls as ACP `configOptions`
(`category: "model"` / `category: "thought_level"`) rather than the top-level
`models` / `modes` other agents use. Two consequences are fixed:

- **Model reporting.** `AcpAgentClient.startThread()` and the one-shot
  `listModels()` now read the effective model from the `model` configOption when
  no `models.currentModelId` is advertised, so hosts see a real model id +
  label (`kimi-code/kimi-for-coding` / "Kimi-k2.6") instead of an empty
  "model unavailable". New exported helpers: `modelIdFromCapabilities`,
  `modelsFromCapabilities`, `modelConfigOption`.

- **Reasoning effort.** `applyReasoning` now falls back to a `thought_level`
  (or id `thinking`) configOption when no ACP mode matches: low-effort tokens
  map to its OFF value, high-effort to its ON value, via
  `session/set_config_option`. This lets a one-shot enrichment turn (`effort:
  "low"`) disable a reasoning model's thinking pass — dramatically faster for
  structured one-shot jobs. New exported helper `reasoningValueForThoughtLevel`.

Additive and backward-compatible: agents that advertise `models`/`modes`
(Gemini, Grok, Qwen) are unaffected; the new behavior only engages when the
corresponding configOption is present and the existing path finds no match.
