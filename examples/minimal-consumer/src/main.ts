// End-to-end demo of @pwrdrvr/agent-kit driving the user's local Codex.
//
//   1. Discover + connect to Codex (no path configured → discovery picks newest).
//   2. Register a host-defined tool the model can call (`get_current_time`).
//   3. Run one real turn, asking the model to use the tool.
//   4. Print the normalized event stream — the same NormalizedThreadEvent shapes
//      any backend (Codex now, ACP later) emits.
//
// Requires a logged-in Codex install. Run: `pnpm --filter minimal-consumer start`.

import { z } from "zod";
import {
  CodexThreadClient,
  defineTool,
  buildToolCatalog,
  dispatchToolCall
} from "@pwrdrvr/agent-client";
import type { NormalizedThreadEvent } from "@pwrdrvr/agent-core";

/** The Codex tool-call params shape `dispatchToolCall` expects — derived from its
 *  signature so the example needs no direct dependency on the protocol package. */
type CodexToolCallParams = Parameters<typeof dispatchToolCall>[0];

async function main(): Promise<void> {
  // 1. A host tool. The kit owns the contract (name + zod schema + dispatch);
  //    the body is ours. The model calls it; agent-client routes it here.
  const getCurrentTime = defineTool({
    namespace: "demo",
    name: "get_current_time",
    description: "Return the current date and time as an ISO 8601 string.",
    argsSchema: z.object({}),
    annotations: { readOnlyHint: true },
    async dispatch() {
      return { ok: true, data: { now: new Date().toISOString() } };
    }
  });
  const catalog = [getCurrentTime];

  // 2. Connect. `command` defaults to discovery (newest installed Codex).
  const client = new CodexThreadClient({ clientName: "agent-kit-demo" });

  // The model's tool call → our catalog's validated dispatch. `onToolCall` now
  // delivers the canonical `AgentBackendToolCall` ({ method, params }); for Codex
  // the params are a `DynamicToolCallParams`.
  client.onToolCall((call) => dispatchToolCall(call.params as CodexToolCallParams, catalog));

  // 3. Print every normalized event. This is the whole point: one neutral
  //    vocabulary regardless of backend.
  let turnDone: (status: string) => void = () => undefined;
  const turnComplete = new Promise<string>((resolve) => {
    turnDone = resolve;
  });

  client.onEvent((event: NormalizedThreadEvent) => {
    switch (event.kind) {
      case "agent_message_delta":
        process.stdout.write(event.delta);
        break;
      case "tool_call":
        console.log(`\n  ↳ [tool_call] ${event.toolCall.name} (kind=${event.toolCall.kind}, status=${event.toolCall.status})`);
        break;
      case "tool_call_update":
        console.log(`  ↳ [tool_call_update] ${event.toolCall.id} → ${event.toolCall.status ?? "?"}`);
        break;
      case "token_usage":
        console.log(`  ↳ [token_usage] ${JSON.stringify(event.usage)}`);
        break;
      case "thread_settings":
        console.log(`  ↳ [thread_settings] model=${event.settings.model ?? "?"}`);
        break;
      case "turn_completed":
        turnDone(event.status);
        break;
      case "error":
        console.error(`  ↳ [error] ${event.message}`);
        turnDone("failed");
        break;
      default:
        break;
    }
  });

  // 4. Start a thread with the tool registered. `tools` is the NEUTRAL,
  //    backend-agnostic catalog slot — a Codex backend casts it to
  //    DynamicToolSpec[]; an ACP backend would ignore it.
  const thread = await client.startThread({
    tools: buildToolCatalog(catalog)
  });
  console.log(`Connected. thread=${thread.threadId} model=${thread.model}\n`);
  console.log("--- assistant ---");

  // 5. Run a turn that should invoke the tool. The NEUTRAL turn input is plain
  //    text (plus optional imagePaths) — the backend builds its native content.
  await client.startTurn({
    threadId: thread.threadId,
    input: {
      text: "What is the current time? Call the get_current_time tool, then tell me the time in one short sentence."
    }
  });

  const status = await turnComplete;
  console.log(`\n--- turn ${status} ---`);
  await client.close();
}

main().catch((error: unknown) => {
  console.error("demo failed:", error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
