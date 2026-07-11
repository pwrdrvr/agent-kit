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
export type ToolSpec<TArgs> = {
  /** Namespace this tool lives under; matched against `DynamicToolCallParams.namespace`. */
  namespace: string;
  /** snake_case agent-facing name, e.g. "library_list". */
  name: string;
  /** Agent-readable, terse. Shown verbatim to Codex. */
  description: string;
  /** zod schema for the tool arguments; also the source of `inputSchema`. */
  argsSchema: z.ZodType<TArgs>;
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
 * Identity helper that preserves `TArgs` inference at each call site, so a
 * tool's `dispatch` body is fully type-checked against its own `argsSchema`
 * without any cast.
 */
export function defineTool<TArgs>(spec: ToolSpec<TArgs>): ToolSpec<TArgs> {
  return spec;
}

/**
 * A `ToolSpec` with its argument type erased — the shape a heterogeneous catalog
 * holds. `defineTool(...)`'s typed result is assignable to this, so a host writes
 * `[defineTool(a), defineTool(b)]` and passes it straight to `buildToolCatalog` /
 * `dispatchToolCall`. Args are validated at runtime, so the erasure is safe.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyToolSpec = ToolSpec<any>;

/**
 * Convert a `ToolSpec` into the protocol function-tool shape nested inside a
 * Codex dynamic-tool namespace. The `inputSchema` is derived from the tool's
 * zod `argsSchema` via zod v4's `z.toJSONSchema()` (JSON Schema draft 2020-12).
 */
export function toDynamicToolNamespaceTool(spec: AnyToolSpec): DynamicToolNamespaceTool {
  return {
    type: "function",
    name: spec.name,
    description: spec.description,
    inputSchema: z.toJSONSchema(spec.argsSchema) as DynamicToolNamespaceTool["inputSchema"]
  };
}

/**
 * Convert a `ToolSpec` into a standalone protocol `DynamicToolSpec`. The current
 * protocol carries namespaces as top-level specs containing function tools, so a
 * single tool becomes a one-tool namespace. `buildToolCatalog` groups tools that
 * share a namespace before registration.
 */
export function toDynamicToolSpec(spec: AnyToolSpec): DynamicToolSpec {
  return {
    type: "namespace",
    name: spec.namespace,
    description: `Tools in the ${spec.namespace} namespace.`,
    tools: [toDynamicToolNamespaceTool(spec)]
  };
}
