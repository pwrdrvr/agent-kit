// Live ACP smoke over the @zed-industries/agent-client-protocol wire layer.
// Build first (`pnpm build`), then: node examples/acp-smoke.mjs <grok|kimi|gemini|qwen>
// Drives discovery → AcpConnection → AcpAgentClient against a REAL installed agent
// and prints whether a session starts and the assistant streams a reply.
import { tmpdir } from "node:os";
import {
  AcpConnection,
  AcpAgentClient,
  strategyById,
  discoverLocalAcpAgentInstances
} from "../packages/agent-acp/dist/index.js";

const agentId = process.argv[2] ?? "grok";
const groups = await discoverLocalAcpAgentInstances();
const group = groups.find((g) => g.strategyId === agentId);
if (!group) {
  console.log(`[${agentId}] NOT installed — nothing to verify`);
  process.exit(2);
}
const strategy = strategyById(agentId);
const inst = group.instances[0];
console.log(`[${agentId}] ${inst.command} (v${inst.version ?? "?"})`);

const transport = new AcpConnection({
  command: inst.command,
  args: group.args,
  env: { ...process.env, ...group.env }
});
const client = new AcpAgentClient({ transport, strategy, clientName: "acp-smoke" });
client.onApprovalRequest(async () => "approved");

let reasoning = 0;
let message = "";
let resolveMsg;
const gotMessage = new Promise((r) => (resolveMsg = r));
client.onEvent((e) => {
  if (e.kind === "reasoning_delta") reasoning += (e.delta ?? "").length;
  else if (e.kind === "agent_message_delta") { message += e.delta ?? ""; resolveMsg(); }
  else if (e.kind === "agent_message") { message = e.message?.text ?? message; resolveMsg(); }
});

try {
  const { threadId } = await client.startThread({ cwd: tmpdir() });
  console.log(`[${agentId}] session: ${threadId}`);
  await client.startTurn({ threadId, input: { text: "Reply with exactly: hello there" } });
  await Promise.race([gotMessage, new Promise((r) => setTimeout(r, 30000))]);
  await new Promise((r) => setTimeout(r, 1500));
  console.log(`[${agentId}] reasoningChars=${reasoning} message=${JSON.stringify(message.trim().slice(0, 120))}`);
  console.log(
    `[${agentId}] ${message.trim().length > 0 ? "✓ ASSISTANT MESSAGE RECEIVED" : reasoning > 0 ? "✓ streaming (model authed)" : "✗ nothing — agent may need `login`"}`
  );
} catch (e) {
  console.log(`[${agentId}] ✗ ERROR: ${e?.message ?? e}`);
} finally {
  await client.close().catch(() => {});
  process.exit(0);
}
