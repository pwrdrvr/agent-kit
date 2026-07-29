import { describe, it, expect, vi } from "vitest";
import { z } from "zod";
import type { DynamicToolCallParams } from "@pwrdrvr/codex-app-server-protocol/v2";
import {
  defineTool,
  toDynamicToolFunctionSpec,
  toDynamicToolSpec,
  type AnyToolSpec,
  type ToolSpec
} from "../src/chat/define-tool";
import { buildToolCatalog, dispatchToolCall } from "../src/chat/tool-catalog";

const emptyInputSchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
  properties: {},
  additionalProperties: false
};

const listInputSchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
  properties: {
    limit: { type: "integer", exclusiveMinimum: 0, maximum: 200 }
  },
  additionalProperties: false
};

const listTool = defineTool({
  namespace: "host_tools",
  name: "library_list",
  description: "List captures in the library.",
  argsSchema: z.object({ limit: z.number().int().positive().max(200).optional() }),
  deferLoading: true,
  annotations: { readOnlyHint: true, idempotentHint: true },
  dispatch: async (args) => ({ ok: true, data: { count: args.limit ?? 0 } })
});

describe("defineTool / toDynamicToolSpec", () => {
  it("converts an unnamespaced tool to the exact top-level function wire shape", () => {
    const pingTool = defineTool({
      name: "ping",
      description: "Check whether the host is available.",
      argsSchema: z.object({}),
      deferLoading: false,
      dispatch: async () => ({ ok: true, data: "pong" })
    });

    expect(toDynamicToolFunctionSpec(pingTool)).toEqual({
      type: "function",
      name: "ping",
      description: "Check whether the host is available.",
      inputSchema: emptyInputSchema,
      deferLoading: false
    });
    expect(toDynamicToolSpec(pingTool)).toEqual({
      type: "function",
      name: "ping",
      description: "Check whether the host is available.",
      inputSchema: emptyInputSchema,
      deferLoading: false
    });
  });

  it("builds one exact namespace object and preserves schemas and deferLoading", () => {
    const renderTool = defineTool({
      namespace: "host_tools",
      name: "render",
      description: "Render a capture.",
      argsSchema: z.object({ id: z.string() }),
      dispatch: async () => ({ ok: true, data: {} })
    });

    expect(buildToolCatalog([listTool, renderTool])).toEqual([
      {
        type: "namespace",
        name: "host_tools",
        description: "Tools in the host_tools namespace.",
        tools: [
          {
            type: "function",
            name: "library_list",
            description: "List captures in the library.",
            inputSchema: listInputSchema,
            deferLoading: true
          },
          {
            type: "function",
            name: "render",
            description: "Render a capture.",
            inputSchema: {
              $schema: "https://json-schema.org/draft/2020-12/schema",
              type: "object",
              properties: { id: { type: "string" } },
              required: ["id"],
              additionalProperties: false
            }
          }
        ]
      }
    ]);
    expect(buildToolCatalog([])).toEqual([]);
  });

  it("emits unnamespaced functions and groups mixed namespaces exactly once", () => {
    const tool = (namespace: string | undefined, name: string): AnyToolSpec => {
      const definition = {
        name,
        description: `Run ${name}.`,
        argsSchema: z.object({}),
        dispatch: async () => ({ ok: true as const, data: {} })
      };
      return namespace === undefined
        ? defineTool(definition)
        : defineTool({ ...definition, namespace });
    };

    expect(
      buildToolCatalog([
        tool("pwrsnap_library", "library_list"),
        tool(undefined, "health_check"),
        tool("pwrsnap_sizzle", "sizzle_render"),
        tool("pwrsnap_library", "library_open")
      ])
    ).toEqual([
      {
        type: "function",
        name: "health_check",
        description: "Run health_check.",
        inputSchema: emptyInputSchema
      },
      {
        type: "namespace",
        name: "pwrsnap_library",
        description: "Tools in the pwrsnap_library namespace.",
        tools: [
          {
            type: "function",
            name: "library_list",
            description: "Run library_list.",
            inputSchema: emptyInputSchema
          },
          {
            type: "function",
            name: "library_open",
            description: "Run library_open.",
            inputSchema: emptyInputSchema
          }
        ]
      },
      {
        type: "namespace",
        name: "pwrsnap_sizzle",
        description: "Tools in the pwrsnap_sizzle namespace.",
        tools: [
          {
            type: "function",
            name: "sizzle_render",
            description: "Run sizzle_render.",
            inputSchema: emptyInputSchema
          }
        ]
      }
    ]);
  });

  it("keeps toDynamicToolSpec runtime-compatible for one namespaced tool", () => {
    expect(toDynamicToolSpec(listTool)).toEqual({
      type: "namespace",
      name: "host_tools",
      description: "Tools in the host_tools namespace.",
      tools: [
        {
          type: "function",
          name: "library_list",
          description: "List captures in the library.",
          inputSchema: listInputSchema,
          deferLoading: true
        }
      ]
    });
  });
});

function call(over: Partial<DynamicToolCallParams>): DynamicToolCallParams {
  return {
    threadId: "t1",
    turnId: "u1",
    callId: "c1",
    namespace: "host_tools",
    tool: "library_list",
    arguments: {} as never,
    ...over
  };
}

describe("dispatchToolCall", () => {
  it("routes a valid call to the matching tool's dispatch", async () => {
    const seen: Array<unknown> = [];
    const tool = defineTool({
      namespace: "host_tools",
      name: "library_list",
      description: "x",
      argsSchema: z.object({ limit: z.number().optional() }),
      dispatch: async (args, ctx) => {
        seen.push([args, ctx]);
        return { ok: true, data: { count: args.limit ?? 0 } };
      }
    });
    const res = await dispatchToolCall(
      call({ arguments: { limit: 5 } as never }),
      [tool as ToolSpec<unknown>]
    );
    expect(seen[0]).toEqual([{ limit: 5 }, { threadId: "t1" }]);
    expect(res.success).toBe(true);
    expect(res.contentItems[0]).toEqual({ type: "inputText", text: JSON.stringify({ count: 5 }) });
  });

  it("rejects an unknown tool without throwing", async () => {
    const res = await dispatchToolCall(call({ tool: "nope" }), [listTool as ToolSpec<unknown>]);
    expect(res.success).toBe(false);
    expect(res.contentItems[0]).toMatchObject({ type: "inputText", text: "Unknown tool: nope" });
  });

  it("rejects an explicit namespace mismatch", async () => {
    const res = await dispatchToolCall(
      call({ namespace: "other_ns" }),
      [listTool as ToolSpec<unknown>]
    );
    expect(res.success).toBe(false);
    expect((res.contentItems[0] as { text: string }).text).toContain("not in namespace");
  });

  it("rejects invalid arguments with a zod-derived message", async () => {
    const res = await dispatchToolCall(
      call({ arguments: { limit: -3 } as never }),
      [listTool as ToolSpec<unknown>]
    );
    expect(res.success).toBe(false);
    expect((res.contentItems[0] as { text: string }).text).toContain("Invalid arguments");
  });

  it("passes through pre-built content items verbatim", async () => {
    const tool: ToolSpec<unknown> = {
      namespace: "host_tools",
      name: "render",
      description: "x",
      argsSchema: z.object({}),
      dispatch: async () => ({
        ok: true,
        contentItems: [{ type: "inputImage", imageUrl: "data:image/png;base64,AAAA" }]
      })
    };
    const res = await dispatchToolCall(call({ tool: "render" }), [tool]);
    expect(res.success).toBe(true);
    expect(res.contentItems).toEqual([
      { type: "inputImage", imageUrl: "data:image/png;base64,AAAA" }
    ]);
  });
});
