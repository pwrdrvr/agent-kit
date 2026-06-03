// Generic catalog-builder + dispatcher derived from a host-supplied `ToolSpec[]`.
//
//   • `buildToolCatalog()` — the `DynamicToolSpec[]` a host registers with Codex
//     at `thread/start`.
//   • `dispatchToolCall()` — routes an incoming `DynamicToolCallParams` back to
//     its matching tool: matches namespace + name, zod-validates the arguments,
//     runs the tool's injected dispatch, and wraps the outcome as a
//     `DynamicToolCallResponse`.
//
// Failure policy: NEVER throw across the tool-call boundary. Unknown tool,
// namespace mismatch, bad arguments, and dispatch errors all return
// `{ success: false }` with a text contentItem describing the problem, so the
// agent can self-correct on its next turn.

import { z } from "zod";
import type {
  DynamicToolCallParams,
  DynamicToolCallResponse,
  DynamicToolSpec
} from "@pwrdrvr/codex-app-server-protocol/v2";
import type { AnyToolSpec } from "./define-tool";
import { toDynamicToolSpec } from "./define-tool";

/**
 * Build the `DynamicToolSpec[]` registered with Codex at `thread/start`. Pure
 * projection of the catalog — an empty catalog yields an empty spec list.
 */
export function buildToolCatalog(catalog: ReadonlyArray<AnyToolSpec>): DynamicToolSpec[] {
  return catalog.map(toDynamicToolSpec);
}

/**
 * Route an incoming `DynamicToolCallParams` to its catalog entry and run it.
 * Always resolves — never throws — so a malformed or unknown call comes back as
 * a `success: false` response the agent can recover from.
 */
export async function dispatchToolCall(
  params: DynamicToolCallParams,
  catalog: ReadonlyArray<AnyToolSpec>
): Promise<DynamicToolCallResponse> {
  const entry = catalog.find((tool) => tool.name === params.tool);
  if (entry === undefined) {
    return errorResponse(`Unknown tool: ${params.tool}`);
  }

  // `namespace` is `string | null` on the wire. Accept a missing/null namespace
  // (Codex may omit it) but reject an explicit mismatch.
  if (params.namespace !== null && params.namespace !== entry.namespace) {
    return errorResponse(`Tool "${params.tool}" is not in namespace "${params.namespace}".`);
  }

  const parsed = entry.argsSchema.safeParse(params.arguments);
  if (!parsed.success) {
    return errorResponse(`Invalid arguments for "${params.tool}": ${formatZodError(parsed.error)}`);
  }

  let result: Awaited<ReturnType<AnyToolSpec["dispatch"]>>;
  try {
    result = await entry.dispatch(parsed.data, { threadId: params.threadId });
  } catch (cause) {
    return errorResponse(
      `Tool "${params.tool}" failed: ${cause instanceof Error ? cause.message : String(cause)}`
    );
  }

  if (!result.ok) {
    return errorResponse(result.error);
  }

  // A tool that returns pre-built content items (e.g. an inputImage) passes them
  // through verbatim so the model SEES the content rather than a JSON blob.
  if ("contentItems" in result) {
    return { success: true, contentItems: result.contentItems };
  }

  return {
    success: true,
    contentItems: [{ type: "inputText", text: JSON.stringify(result.data) }]
  };
}

function errorResponse(message: string): DynamicToolCallResponse {
  return {
    success: false,
    contentItems: [{ type: "inputText", text: message }]
  };
}

function formatZodError(error: z.ZodError): string {
  return error.issues
    .map((issue) => {
      const path = issue.path.join(".");
      return path.length > 0 ? `${path}: ${issue.message}` : issue.message;
    })
    .join("; ");
}
