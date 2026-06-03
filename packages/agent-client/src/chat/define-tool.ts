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
// so no one writes `any`. The catalog is then a homogeneous `ToolSpec<unknown>[]`
// that the generator + dispatcher treat uniformly.

import { z } from "zod";
import type {
  DynamicToolCallOutputContentItem,
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
 * Convert a `ToolSpec` into the protocol `DynamicToolSpec` registered with Codex
 * at `thread/start`. The `inputSchema` is derived from the tool's zod
 * `argsSchema` via zod v4's `z.toJSONSchema()` (JSON Schema draft 2020-12).
 */
export function toDynamicToolSpec(spec: ToolSpec<unknown>): DynamicToolSpec {
  return {
    namespace: spec.namespace,
    name: spec.name,
    description: spec.description,
    inputSchema: z.toJSONSchema(spec.argsSchema) as DynamicToolSpec["inputSchema"]
  };
}
