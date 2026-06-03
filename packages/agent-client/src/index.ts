// @pwrdrvr/agent-client — Codex App Server adapter for agent-kit.
//
// Three surfaces, all normalizing into the agent-core neutral schema:
//   • CodexThreadClient   — long-lived, multi-turn thread client (normalized
//                           event stream + injected tool/approval handlers);
//   • CodexOneShotClient  — one-shot structured-output enrichment turns;
//   • ChatThreadController — surface-agnostic chat controller over the thread
//                            client, with persistence + prompt + catalog seams
//                            injected by the host.
//
// Plus the normalization layer (Codex v2 notifications → NormalizedThreadEvent)
// and the chat tool-definition primitives.

export {
  CodexThreadClient,
  type CodexThreadClientOptions,
  type CodexThreadClientTransportFactory,
  type CodexStartThreadOptions,
  type CodexStartTurnOptions,
  type CodexToolCallHandler,
  type CodexApprovalHandler,
  type StartThreadResult,
  type Unsubscribe
} from "./codex-thread-client";

export {
  CodexOneShotClient,
  type CodexOneShotClientOptions,
  type CodexOneShotTransportFactory,
  type CodexOneShotRequest,
  type CodexOneShotResponse,
  type CodexModelOption
} from "./codex-oneshot-client";

export { DISABLE_CODING_AGENT_THREAD_CONFIG } from "./codex-thread-config";

export {
  normalizeNotification,
  normalizeTokenUsage,
  normalizeThreadSettings,
  normalizeThreadItemToolCall,
  normalizeDynamicToolCall,
  normalizeApprovalRequest,
  CODEX_NOTIFICATION_METHODS,
  CODEX_APPROVAL_METHODS,
  CODEX_TOOL_CALL_METHOD
} from "./normalize";

export {
  defineTool,
  toDynamicToolSpec,
  type ToolSpec,
  type AnyToolSpec,
  type ToolDispatchResult
} from "./chat/define-tool";

export { buildToolCatalog, dispatchToolCall } from "./chat/tool-catalog";

export {
  ChatThreadController,
  localDateStamp,
  type ChatThreadControllerDeps,
  type ChatThreadView,
  type ChatBroadcast,
  type ChatSystemPromptBuilder,
  type ChatSettingsSnapshot,
  type ToolLabelMap
} from "./chat/chat-thread-controller";
