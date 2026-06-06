# Adopt `@zed-industries/agent-client-protocol` for the ACP wire layer

- **Date:** 2026-06-06
- **Status:** Proposed
- **Package:** `@pwrdrvr/agent-acp`
- **Consumers (only two, both local branches):** PwrSnap, PwrAgent

## Problem

`@pwrdrvr/agent-acp` hand-rolls the ACP (Agent Client Protocol) wire layer:
the message **types** and the JSON-RPC **client calls** (`initialize`,
`session/new`, `session/prompt`, `session/update`, `session/set_model`, …) are
written by hand over our own `@pwrdrvr/agent-transport` `JsonRpcConnection`.
This was inherited verbatim from PwrAgnt's in-tree code; there was never a
"build vs. buy" decision.

The official, spec-tracked library exists and is healthy:
**`@zed-industries/agent-client-protocol@0.4.5`** (Apache-2.0 — on our
always-allowed list). Hand-written ACP shapes drift from the spec as ACP
evolves — the same class of bug we've hit repeatedly (Codex config churn, kimi
help-text drift). Adopting the library moves the protocol types + the client
connection onto a maintained, validated implementation.

## What the library is (verified against the 0.4.5 tarball)

Ships `dist/{acp,schema,jsonrpc,stream}`:

- **`ClientSideConnection(toClient, stream)`** — the ACP client. Typed methods:
  `initialize`, `newSession`, `loadSession`, `setSessionMode`,
  `setSessionModel`, `authenticate`, `prompt`, `cancel`. Plus `extMethod` /
  `extNotification` escape hatches for non-standard methods/notifications.
- **`schema`** — the canonical ACP types, generated from `schema/schema.json`.
  Covers every `session/update` variant our normalizer consumes
  (`user_message_chunk`, `agent_message_chunk`, `agent_thought_chunk`,
  `tool_call`, `tool_call_update`, `plan`, `available_commands`, `current_mode`)
  and model/mode selection (`SetSessionModelRequest`, `availableModels`,
  `currentModelId`, `SetSessionModeRequest`).
- **`ndJsonStream(toAgentStdin, fromAgentStdout)`** — newline-delimited JSON
  framing over two web streams. ⚠️ Arg order footgun: the FIRST arg is the
  `WritableStream` we write to (the agent's stdin), the SECOND is the
  `ReadableStream` we read from (the agent's stdout). See `examples/client.ts`.
- **`Client` handler** (the `toClient` factory return): `requestPermission`,
  `sessionUpdate`, optional `writeTextFile` / `readTextFile` / `createTerminal`.

It does **NOT** ship (confirmed: zero `child_process` / `spawn` / `which` /
`PATH` / discovery in dist):

- agent **discovery** (which CLIs are installed, fallback paths, version-manager
  scanning, the kimi exit-code probe) — **ours**.
- process **spawning + lifetime** (spawn the agent CLI, restart, pool) — **ours**
  (the library's own example spawns the child itself and hands the streams in).

## Gap analysis (no feature loss)

| We use today | Library coverage |
|---|---|
| `session/new`, `session/prompt`, `session/cancel`, `initialize` | typed methods ✓ |
| `session/set_model` (+ list models: `availableModels`/`currentModelId`) | `setSessionModel` ✓ |
| `session/set_mode` | `setSessionMode` ✓ |
| `session/update` variants (message/thought/tool_call/tool_call_update/plan) | typed `SessionNotification` ✓ |
| `session/set_config_option` (not standard ACP) | via `extMethod` ✓ |
| Grok vendor `session_summary_generated` notification | via `extNotification` → our `vendorNotificationMethods` quirk ✓ |
| `session/request_permission` (approvals) | `Client.requestPermission` ✓ |

Everything maps. Non-standard bits ride the library's extension hooks.

## What we KEEP (the value; the library has none of it)

- **Discovery** — `discoverLocalAcpAgentInstances`, `BUILT_IN_ACP_STRATEGIES`,
  `strategyById` / `strategyByBackendId`, fallback paths, version-manager scan,
  kimi exit-code probe.
- **Strategies / per-agent quirks** — `surfaceThoughts`, `titleFrom`,
  `vendorNotificationMethods`, spawn spec.
- **Normalizer** — `AcpSessionNormalizer` (ACP `session/update` → neutral
  `NormalizedThreadEvent`). Its INPUT is retyped from our hand-shapes to the
  library's `schema.SessionNotification` (strictly better — spec-typed).
- **`AgentBackend` adapters** — `AcpAgentClient`, `AcpOneShotClient`,
  `AcpAgentClientPool` keep their public shape (the controller drives them).
- **Process spawn + lifecycle** — extracted into the new connection module.

## Public API impact (the consumer repoint)

`agent-acp` exports that STAY stable (consumers untouched):
`AcpAgentClient`, `AcpOneShotClient`, `AcpAgentClientPool`,
`discoverLocalAcpAgent*`, `BUILT_IN_ACP_STRATEGIES`, `strategyById`,
`strategyByBackendId`, the normalizer + runtime-capabilities helpers, all the
discovery/result types.

Export that CHANGES / is retired:
- **`AcpStdioJsonRpcTransport`** (+ `AcpJsonRpcTransport`,
  `AcpStdioJsonRpcTransportOptions`) — our hand-rolled stdio JSON-RPC transport.
  Replaced internally by a new `AcpConnection` over the library's
  `ClientSideConnection`. `AcpAgentClient`'s constructor currently takes a
  `transport: AcpJsonRpcTransport`; it will instead take the new connection
  seam (still injectable, still fakeable for tests).

**Consumer changes required (accepted — both are local branches):**
- **PwrSnap** — `apps/desktop/src/main/handlers/acp-handlers.ts` and
  `chat-controller-factory.ts` import + construct `AcpStdioJsonRpcTransport`.
  They repoint to the new construction (a few lines each). Discovery + the
  `AgentBackend` wiring are unchanged.
- **PwrAgent** — equivalent repoint if/when it consumes the kit's ACP (parity).

This is a MAJOR version bump of `agent-acp` (breaking the transport export).

## Plan (phased, checkpoint commits, publish only when fully green)

The old path stays intact until the new one is proven, so the package never
ships half-migrated.

### Unit 1 — Add the dependency + a wire `AcpConnection`
- Add `@zed-industries/agent-client-protocol` to `agent-acp` deps (pin exact if
  the pnpm trust gate flags `^`; use `--ignore-pnpmfile` as elsewhere).
- New `src/acp-connection.ts`: spawns the agent (command + args + env from the
  strategy/discovery), wires `Readable.toWeb(stdout)` / `Writable.toWeb(stdin)`
  → `ndJsonStream` → `ClientSideConnection`, owns process lifetime
  (close/kill, error surfacing), and exposes a small seam the clients drive
  (`initialize`, `newSession`, `prompt`, `setModel`, `setMode`, `cancel`,
  `extMethod`, an `onSessionUpdate`/`onExtNotification` subscription).
- `Client` handler: `requestPermission` → injected approval handler;
  `sessionUpdate` → injected normalizer feed; `extNotification` → vendor hook;
  `read/writeTextFile` + `createTerminal` → conservative deny/stub (we don't
  grant fs/terminal to chat agents).
- **Verify:** unit tests with an in-memory paired stream (no real process) —
  round-trip `initialize`/`newSession`/`prompt`, an `agent_message_chunk`
  notification reaching the handler, and an `extNotification` reaching the hook.

### Unit 2 — Retype the normalizer onto `schema.SessionNotification`
- `AcpSessionNormalizer.apply` input → the library's `SessionNotification`
  union (keep the neutral OUTPUT identical). The quirk table is unchanged.
- **Verify:** existing normalizer tests pass with the retyped input; the
  KTD-A2 "no agent-id branch" guard still holds.

### Unit 3 — Rewire `AcpAgentClient` onto `AcpConnection`
- Replace the `transport: AcpJsonRpcTransport` internals with `AcpConnection`;
  keep the public `AgentBackend` methods identical. `set_config_option` →
  `extMethod`. Title/runtime-capability handlers stay.
- **Verify:** existing `acp-client` tests (fake transport → fake connection);
  the synthetic-strategy extensibility test; full agent-acp suite green.

### Unit 4 — Rewire `AcpOneShotClient` + `AcpAgentClientPool`
- Same connection swap; preserve their public surface (one-shot structured
  turn, model listing, pool factory).
- **Verify:** unit tests; `acp:models`-style listing exercised via fakes.

### Unit 5 — Retire `AcpStdioJsonRpcTransport`
- Delete the hand-rolled transport + its `AcpJsonRpcTransport` interface (now
  internal to `AcpConnection`). Update `index.ts` exports. Update dependency-
  cruiser if needed (agent-acp may now import the library — allow it).
- **Verify:** build + typecheck + full kit suite + `lint:boundaries` green.

### Unit 6 — Live re-verification (split per the decision below)
- **I drive:** whichever agents are already authed on this machine
  (grok at `~/.grok/bin/grok`, kimi at `~/.kimi-code/bin/kimi`) — a real
  `session/new` + `session/prompt` round-trip through the new path, asserting a
  streamed assistant message + a clean close.
- **You spot-check:** any agent needing interactive login (likely
  gemini/qwen) — I hand you a one-command script (`node scripts/acp-smoke.mjs
  <agentId>`).
- THEN: changeset (major), publish, and the PwrSnap/PwrAgent transport repoints.

## Live verification ownership

Per decision: **I verify what I can; you spot-check the rest.** Unit + types do
the heavy lifting (the library's zod validation + our suite); I live-run the
already-authed agents; you run the login-gated ones with the provided one-liner
before we publish.

## Risks / open questions

1. **`extMethod` shape for `set_config_option`.** Confirm the library's
   `extMethod(method, params)` reaches the agent as a raw `method` call (it
   should — that's its purpose). Fallback: keep a tiny raw-request path on the
   connection. *Resolve in Unit 1.*
2. **Protocol-version negotiation.** The library's `initialize` negotiates a
   protocol version; confirm our four agents agree on a version the library
   supports (0.4.5). *Resolve in Unit 6 live runs.*
3. **Web-stream backpressure / partial frames.** `ndJsonStream` owns framing;
   verify large tool outputs stream without truncation. *Covered by Unit 1 +
   live runs.*
4. **Two JSON-RPC stacks** (library's for ACP, ours for Codex). Accepted by the
   owner — no consolidation required.
5. **PwrAgent parity.** This plan is written so the same repoint applies to
   PwrAgent; sequence after PwrSnap.

## Rollout

1. Units 1–5 on `agent-kit` main, checkpoint commits, **no publish**.
2. Unit 6 live verification (split). Fix anything surfaced.
3. Changeset → **major** `agent-acp` bump → publish via the OIDC release flow.
4. PwrSnap: bump `agent-acp`, repoint the two transport call sites, re-verify,
   commit on its branch.
5. PwrAgent: same repoint (follow-up).
