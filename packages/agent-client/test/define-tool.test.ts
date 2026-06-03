import { describe, it, expect, vi } from "vitest";
import { z } from "zod";
import type { DynamicToolCallParams } from "@pwrdrvr/codex-app-server-protocol/v2";
import { defineTool, toDynamicToolSpec, type ToolSpec } from "../src/chat/define-tool";
import { buildToolCatalog, dispatchToolCall } from "../src/chat/tool-catalog";

const listTool = defineTool({
  namespace: "host_tools",
  name: "library_list",
  description: "List captures in the library.",
  argsSchema: z.object({ limit: z.number().int().positive().max(200).optional() }),
  annotations: { readOnlyHint: true, idempotentHint: true },
  dispatch: async (args) => ({ ok: true, data: { count: args.limit ?? 0 } })
});

describe("defineTool / toDynamicToolSpec", () => {
  it("serializes a tool spec to a valid DynamicToolSpec via z.toJSONSchema", () => {
    const spec = toDynamicToolSpec(listTool as ToolSpec<unknown>);
    expect(spec.namespace).toBe("host_tools");
    expect(spec.name).toBe("library_list");
    expect(spec.description).toBe("List captures in the library.");
    expect(spec.inputSchema).toMatchObject({
      type: "object",
      properties: {
        limit: { type: "integer", exclusiveMinimum: 0, maximum: 200 }
      }
    });
  });

  it("builds the catalog as a pure projection of the tool list", () => {
    const catalog = buildToolCatalog([listTool as ToolSpec<unknown>]);
    expect(catalog).toHaveLength(1);
    expect(catalog[0]?.name).toBe("library_list");
    expect(buildToolCatalog([])).toEqual([]);
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
