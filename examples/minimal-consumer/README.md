# minimal-consumer

A ~90-line end-to-end demo of `@pwrdrvr/agent-kit` driving the user's **local
Codex** — discovery, connection, a host-defined tool the model calls, and one
real turn, all observed through the neutral `NormalizedThreadEvent` stream.

## Run

Requires a logged-in Codex install (Codex Desktop or the `codex` CLI).

```bash
pnpm install
pnpm --filter minimal-consumer start
```

## What it does

1. Defines a host tool (`get_current_time`) with `defineTool` — name + zod schema
   + a `dispatch` body the kit never sees until it validates the args.
2. Connects with `new CodexThreadClient({ clientName: "agent-kit-demo" })` —
   discovery picks the newest installed Codex; no path configured.
3. Registers the tool, subscribes to `onEvent`, runs one turn asking the model to
   call the tool.
4. Prints every normalized event.

## Sample output

```
Connected. thread=019e8bb6-… model=gpt-5.5

--- assistant ---
  ↳ [tool_call] get_current_time (kind=read, status=in_progress)
  ↳ [tool_call_update] call_bOVJbp7… → completed
  ↳ [token_usage] {"inputTokens":18235,"cachedInputTokens":3456,"outputTokens":15,...}
The current time is 4:21 AM UTC on June 3, 2026.
--- turn completed ---
```

The same `NormalizedThreadEvent` shapes a host renders here are what an ACP
backend (Kimi/Qwen/Gemini/Grok) will emit — so a UI built on them is
backend-agnostic.
