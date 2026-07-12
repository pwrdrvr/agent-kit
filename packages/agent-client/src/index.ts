// @pwrdrvr/agent-client — Codex App Server adapter for agent-kit.
//
// Surfaces, all normalizing into the agent-core neutral schema:
//   • CodexProcessOwner   — owns ONE codex app-server process + connection and
//                           hands out per-surface backend VIEWS (each an
//                           AgentBackend whose threads route to its own
//                           handlers), plus model listing + structured one-shot
//                           over the shared connection. Pool it for the app.
//   • CodexBackendView    — a lightweight per-surface AgentBackend over an owner;
//                           sibling surfaces sharing one process never clobber.
//   • CodexProcessOwnerPool — lifecycle pool of owners keyed on connection
//                           identity (command, CODEX_HOME/env). One process per key.
//   • CodexThreadClient   — thin single-view shim over an owner (one process, one
//                           global handler slot) — the historical surface.
//   • CodexOneShotClient  — thin shim over owner.runOneShot()/listModels().
//   • ChatThreadController — surface-agnostic chat controller over any
//                           AgentBackend (a view or a thread client).
//
// Plus the normalization layer (Codex v2 notifications → NormalizedThreadEvent)
// and the chat tool-definition primitives.

export {
  CodexProcessOwner,
  CodexBackendView,
  type CodexProcessOwnerOptions,
  type CodexOneShotWorkerOptions,
  type CodexTransportFactory
} from "./codex-process-owner";

export {
  CodexProcessOwnerPool,
  type CodexProcessOwnerFactory,
  type CodexProcessOwnerPoolOptions
} from "./codex-process-owner-pool";

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
  type ChatBackend,
  type ChatBroadcast,
  type ChatControllerEvent,
  type ChatSystemPromptBuilder,
  type ToolLabelMap
} from "./chat/chat-thread-controller";
