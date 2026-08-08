import { describe, expect, it } from "vitest";
import {
  normalizeAcpMcpServerConfig,
  normalizeAcpMcpServerConfigs,
  type AcpMcpServerConfig
} from "../src/mcp-server-config";

describe("ACP MCP server wire normalization", () => {
  it("preserves the existing stdio input and emits required args/env arrays", () => {
    const legacy: AcpMcpServerConfig = {
      name: "local-tools",
      command: "/opt/local-tools",
      env: { TOKEN: "secret", SOCKET: "/tmp/tools.sock" }
    };

    const wire = normalizeAcpMcpServerConfig(legacy);

    expect(wire).toEqual({
      name: "local-tools",
      command: "/opt/local-tools",
      args: [],
      env: [
        { name: "TOKEN", value: "secret" },
        { name: "SOCKET", value: "/tmp/tools.sock" }
      ]
    });
  });

  it("accepts the exact stdio env array without retaining caller objects", () => {
    const env = [{ name: "TOKEN", value: "secret" }];
    const wire = normalizeAcpMcpServerConfig({
      name: "local-tools",
      command: "local-tools",
      args: ["serve"],
      env
    });

    env[0]!.value = "changed";
    expect(wire).toEqual({
      name: "local-tools",
      command: "local-tools",
      args: ["serve"],
      env: [{ name: "TOKEN", value: "secret" }]
    });
  });

  it("emits exact HTTP and SSE wire payloads from record or array headers", () => {
    const wire = normalizeAcpMcpServerConfigs([
      {
        name: "remote-http",
        type: "http",
        url: "https://mcp.example.test/rpc",
        headers: { Authorization: "Bearer http-secret" }
      },
      {
        name: "remote-sse",
        type: "sse",
        url: "https://mcp.example.test/events",
        headers: [{ name: "X-Api-Key", value: "sse-secret" }]
      }
    ]);

    expect(wire).toEqual([
      {
        name: "remote-http",
        type: "http",
        url: "https://mcp.example.test/rpc",
        headers: [{ name: "Authorization", value: "Bearer http-secret" }]
      },
      {
        name: "remote-sse",
        type: "sse",
        url: "https://mcp.example.test/events",
        headers: [{ name: "X-Api-Key", value: "sse-secret" }]
      }
    ]);
  });
});
