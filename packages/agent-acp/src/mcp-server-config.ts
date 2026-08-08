import type { McpServer } from "@agentclientprotocol/sdk";

/** ACP key/value entry used by stdio environments and HTTP headers. */
export type AcpMcpKeyValue = {
  name: string;
  value: string;
};

/** Host-friendly collection accepted wherever ACP requires key/value entries. */
export type AcpMcpKeyValueCollection =
  | Readonly<Record<string, string>>
  | readonly AcpMcpKeyValue[];

/** Backward-compatible stdio MCP configuration. ACP stdio has no `type` field. */
export type AcpStdioMcpServerConfig = {
  name: string;
  command: string;
  args?: readonly string[];
  env?: AcpMcpKeyValueCollection;
};

/** Streamable HTTP MCP configuration from the ACP v1 schema. */
export type AcpHttpMcpServerConfig = {
  name: string;
  type: "http";
  url: string;
  headers: AcpMcpKeyValueCollection;
};

/** Legacy HTTP+SSE MCP configuration from the ACP v1 schema. */
export type AcpSseMcpServerConfig = {
  name: string;
  type: "sse";
  url: string;
  headers: AcpMcpKeyValueCollection;
};

/** Public MCP input accepted by agent-acp session lifecycle methods. */
export type AcpMcpServerConfig =
  | AcpStdioMcpServerConfig
  | AcpHttpMcpServerConfig
  | AcpSseMcpServerConfig;

/** Exact MCP server wire union from the pinned ACP protocol library. */
export type AcpMcpServerWireConfig = McpServer;

function isKeyValueArray(
  collection: AcpMcpKeyValueCollection
): collection is readonly AcpMcpKeyValue[] {
  return Array.isArray(collection);
}

function normalizeKeyValues(
  collection: AcpMcpKeyValueCollection | undefined
): AcpMcpKeyValue[] {
  if (collection === undefined) return [];
  if (isKeyValueArray(collection)) {
    return collection.map(({ name, value }) => ({ name, value }));
  }
  return Object.entries(collection).map(([name, value]) => ({ name, value }));
}

/** Serialize a host-friendly config into the exact ACP v1 wire representation. */
export function normalizeAcpMcpServerConfig(
  server: AcpMcpServerConfig
): AcpMcpServerWireConfig {
  if ("type" in server) {
    return {
      name: server.name,
      type: server.type,
      url: server.url,
      headers: normalizeKeyValues(server.headers)
    };
  }
  return {
    name: server.name,
    command: server.command,
    args: [...(server.args ?? [])],
    env: normalizeKeyValues(server.env)
  };
}

/** Serialize a per-session list without retaining mutable caller collections. */
export function normalizeAcpMcpServerConfigs(
  servers: readonly AcpMcpServerConfig[]
): AcpMcpServerWireConfig[] {
  return servers.map(normalizeAcpMcpServerConfig);
}

/**
 * Remove credential-bearing MCP values from a lifecycle error. The server URL
 * is redacted in full because it may carry user-info or query credentials.
 */
export function redactAcpMcpCredentials(
  message: string,
  servers: readonly AcpMcpServerConfig[]
): string {
  const secrets = new Set<string>();
  for (const server of servers) {
    const values =
      "type" in server
        ? [server.url, ...normalizeKeyValues(server.headers).map(({ value }) => value)]
        : normalizeKeyValues(server.env).map(({ value }) => value);
    for (const value of values) {
      if (value.length > 0) secrets.add(value);
    }
  }
  let redacted = message;
  for (const secret of [...secrets].sort((a, b) => b.length - a.length)) {
    redacted = redacted.split(secret).join("[REDACTED]");
  }
  return redacted;
}
