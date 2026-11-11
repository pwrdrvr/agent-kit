// `@pwrdrvr/agent-acp/mcp-server-config`: MCP server config normalization.
// It uses only the SDK's types, which erase at build, so it does not load
// `@agentclientprotocol/sdk` (see src/entries/strategies.ts).

export {
  normalizeAcpMcpServerConfig,
  normalizeAcpMcpServerConfigs,
  type AcpMcpServerConfig,
  type AcpStdioMcpServerConfig,
  type AcpHttpMcpServerConfig,
  type AcpSseMcpServerConfig,
  type AcpMcpKeyValue,
  type AcpMcpKeyValueCollection,
  type AcpMcpServerWireConfig
} from "../mcp-server-config";
