---
"@pwrdrvr/agent-acp": minor
---

Fix ACP model selection, which threw before the request ever left the process, and route it through the config option when that is how the agent advertises model choice.

**The bug.** Every ACP model selection failed with `conn.setSessionModel is not a function`. ACP 1.3 has no `session/set_model`: it is absent from the SDK's `AGENT_METHODS`, and `ClientSideConnection` exposes no `setSessionModel`. But `AcpAgentConnection` still declared one, and `createConnection` attaches the real `ClientSideConnection` with an `as unknown as` cast that erases the structural check — so the dead name type-checked and threw at runtime, for every agent, on every `startThread({ model })`. `AcpAgentClient.startThread` catches and debug-logs it, so the only symptom was a session quietly running on the agent's default model.

The declaration and its dispatch case are gone. `session/set_model` now rides `dispatch`'s default arm, which sends it verbatim through the SDK's generic `request()` — agents that still accept it as a vendor extension keep working.

**The routing.** `setModel` now picks its route from the advertised capabilities: `session/set_config_option` against the `model` option (`category: "model"`, or a literal `model` id) when the agent publishes no `models.availableModels`, and `session/set_model` when it does. This is the write twin of a distinction the read path has always made — `modelIdFromCapabilities` and `modelsFromCapabilities` both fall back to the config option — and the two disagreeing is what let a host list models it could not then select.

Preferring the config option is not only spec-correctness. Its reply carries the agent's full refreshed config set, so a capability-dependent step that runs straight afterwards sees the new state; `session/set_model` answers `{}` and refreshes only via an async `config_option_update` notification. That matters immediately: on Kimi, switching model changes which thought levels exist (`K2.7 Coding` offers only `on`, `K3` offers `low`/`high`/`max`), and `applyReasoning` runs off `runtimeCapabilities` right after the model is set.

Measured against Kimi Code CLI 0.29.2, whose `session/new` returns a `model` config option and no `models` capability at all: `session/set_config_option {configId: "model"}` is accepted and echoes the new `currentValue`. Kimi does also still honour `session/set_model`, so for that agent the first half of this change alone restores the behaviour; the routing is what keeps it working on an agent that implements only what ACP 1.3 defines.

A model write routed through a config option records both `currentModelId` and `configValues[id]` in the session's runtime state, so a consumer reading `thread_settings.model` need not know which route the agent exposed.

Type changes: `AcpRuntimeOptionSource` gains `"modelConfigOption"`; `AcpAgentConnection` drops `setSessionModel`.
