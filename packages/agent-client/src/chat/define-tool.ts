// Type-safe tool-definition primitive for a host's chat tool catalog.
//
// A host exposes its tool catalog to Codex as `DynamicToolSpec[]` (registered
// at `thread/start`). Each `ToolSpec` pairs an agent-readable description + a
// zod argument schema (the audit surface) with a single `dispatch` body the
// host injects (it runs whatever the host wants — a command bus, an RPC, a
// direct call). The kit never imports any concrete dispatch target.
//
// `defineTool` is an identity helper: it preserves each call site's `TArgs`
// inference (the `argsSchema`'s inferred type flows into the `dispatch` body)
// so the host never writes `any`. At the catalog boundary the type parameter is
// erased to `AnyToolSpec` (see below): a catalog mixes tools with different
// `TArgs`, and `ToolSpec<TArgs>` is contravariant in `TArgs` via `dispatch`, so
// `ToolSpec<{a:number}>` is NOT assignable to `ToolSpec<unknown>`. Erasing to
// `any` at the boundary is sound because `dispatchToolCall` zod-validates the
// arguments at runtime before the typed `dispatch` body ever sees them.

import { z } from "zod";
import type {
  DynamicToolCallOutputContentItem,
  DynamicToolNamespaceTool,
  DynamicToolSpec
} from "@pwrdrvr/codex-app-server-protocol/v2";

/**
 * Result of a tool `dispatch`. The agent only ever sees text or image content,
 * so a structured host error is collapsed to a plain string at this boundary.
 */
export type ToolDispatchResult =
  | { ok: true; data: unknown }
  // For tools that return rich content the agent must SEE rather than read as
  // JSON (e.g. an `inputImage` data URL), pass content items through verbatim
  // instead of JSON-stringifying.
  | { ok: true; contentItems: DynamicToolCallOutputContentItem[] }
  | { ok: false; error: string };

/**
 * One chat tool. The single audit unit: description (what the agent reads),
 * `argsSchema` (what the agent must satisfy — validated before dispatch), and
 * `dispatch` (the host-injected body it resolves to).
 */
type ToolSpecDefinition<TArgs> = {
  /** snake_case agent-facing name, e.g. "library_list". */
  name: string;
  /** Agent-readable, terse. Shown verbatim to Codex. */
  description: string;
  /** zod schema for the tool arguments; also the source of `inputSchema`. */
  argsSchema: z.ZodType<TArgs>;
  /** Ask Codex to defer loading this function's definition until it is needed. */
  deferLoading?: boolean;
  /**
   * Behaviour hints surfaced to the agent / approval UI. Optional per tool;
   * omit (rather than set `undefined`) when not applicable —
   * `exactOptionalPropertyTypes` is on.
   */
  annotations?: {
    destructiveHint?: boolean;
    readOnlyHint?: boolean;
    idempotentHint?: boolean;
  };
  /**
   * The host-injected dispatch this tool resolves to. Receives the zod-validated
   * args (typed as `TArgs`) plus the calling thread id.
   */
  dispatch: (args: TArgs, ctx: { threadId: string }) => Promise<ToolDispatchResult>;
};

/**
 * A namespaced chat tool. The namespace is matched against
 * `DynamicToolCallParams.namespace`.
 */
export type ToolSpec<TArgs> = ToolSpecDefinition<TArgs> & {
  namespace: string;
};

/** A top-level function tool that does not belong to a namespace. */
export type UnnamespacedToolSpec<TArgs> = ToolSpecDefinition<TArgs> & {
  namespace?: never;
};

/**
 * Identity helper that preserves `TArgs` inference at each call site, so a
 * tool's `dispatch` body is fully type-checked against its own `argsSchema`
 * without any cast.
 */
export function defineTool<TArgs>(spec: ToolSpec<TArgs>): ToolSpec<TArgs>;
export function defineTool<TArgs>(
  spec: UnnamespacedToolSpec<TArgs>
): UnnamespacedToolSpec<TArgs>;
export function defineTool<TArgs>(
  spec: ToolSpec<TArgs> | UnnamespacedToolSpec<TArgs>
): ToolSpec<TArgs> | UnnamespacedToolSpec<TArgs> {
  return spec;
}

/**
 * A `ToolSpec` with its argument type erased — the shape a heterogeneous catalog
 * holds. `defineTool(...)`'s typed result is assignable to this, so a host writes
 * `[defineTool(a), defineTool(b)]` and passes it straight to `buildToolCatalog` /
 * `dispatchToolCall`. Args are validated at runtime, so the erasure is safe.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyToolSpec = ToolSpec<any> | UnnamespacedToolSpec<any>;

/**
 * Convert a `ToolSpec` into the protocol's discriminated function-tool shape.
 * The same shape is valid both as a top-level `DynamicToolSpec` and inside a
 * namespace. The `inputSchema` is derived from the tool's zod `argsSchema` via
 * zod v4's `z.toJSONSchema()` (JSON Schema draft 2020-12).
 */
export function toDynamicToolFunctionSpec(spec: AnyToolSpec): DynamicToolNamespaceTool {
  return {
    type: "function",
    name: spec.name,
    description: spec.description,
    inputSchema: z.toJSONSchema(spec.argsSchema) as DynamicToolNamespaceTool["inputSchema"],
    ...(spec.deferLoading === undefined ? {} : { deferLoading: spec.deferLoading })
  };
}

/**
 * Convert one `ToolSpec` into a valid standalone protocol `DynamicToolSpec`.
 *
 * @deprecated Use `toDynamicToolFunctionSpec` when a flat function shape is
 * needed, or `buildToolCatalog` when registering a catalog with Codex. A
 * one-tool conversion cannot group multiple tools that share a namespace.
 */
export function toDynamicToolSpec(spec: AnyToolSpec): DynamicToolSpec {
  const functionSpec = toDynamicToolFunctionSpec(spec);
  if (spec.namespace === undefined) {
    return functionSpec;
  }

  return {
    type: "namespace",
    name: spec.namespace,
    description: `Tools in the ${spec.namespace} namespace.`,
    tools: [functionSpec]
  };
}
