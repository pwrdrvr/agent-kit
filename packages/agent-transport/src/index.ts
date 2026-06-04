// @pwrdrvr/agent-transport — generic JSON-RPC 2.0 + stdio transport, plus the
// shared login-shell PATH hydration every desktop host needs before spawning.
// Shared by the Codex App Server adapter and ACP adapters.

export {
  JsonRpcConnection,
  type JsonRpcId,
  type JsonRpcTransport,
  type JsonRpcNotificationHandler,
  type JsonRpcRequestHandler,
  type JsonRpcObserver,
  type JsonRpcObserverEvent,
  type JsonRpcObserverDiagnostics,
  type JsonRpcConnectionOptions
} from "./json-rpc";

export {
  StdioJsonRpcTransport,
  type StdioJsonRpcTransportOptions
} from "./stdio-transport";

export {
  hydrateProcessEnvFromLoginShell,
  mergeLoginShellEnvIntoEnv,
  resolveInteractiveLoginShellEnv,
  prependCommandDirToPath,
  type ResolveLoginShellEnvOptions,
  type MergeLoginShellEnvOptions
} from "./shell-env";
