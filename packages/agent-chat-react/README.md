# @pwrdrvr/agent-chat-react

A **purely presentational** React chat UI for
[`@pwrdrvr/agent-kit`](https://github.com/pwrdrvr/agent-kit). Props in,
callbacks out — **no IPC, bus, transport, or persistence**. It renders the
kit's neutral [`@pwrdrvr/agent-core`](../agent-core) thread shapes and emits
user intents (submit a message, approve/deny an approval, interrupt a turn).

A host (e.g. a PwrSnap / GIPHY renderer) wires these components to
[`@pwrdrvr/agent-client`](../agent-client). This package never imports
`agent-client`, `agent-transport`, Electron, or any backend — it is typed
only against `agent-core`'s neutral types and its own presentational props.

## Install

```sh
pnpm add @pwrdrvr/agent-chat-react @pwrdrvr/agent-core react react-dom
```

`react` is a peer dependency (`^18 || ^19`).

## Styles

The components reference design tokens (CSS custom properties). Import the
bundled stylesheet **once** in your app:

```ts
import "@pwrdrvr/agent-chat-react/styles.css";
```

It ships a dark, pure-black + tangerine theme out of the box. To retheme,
override the tokens (`--accent`, `--bg-panel`, `--text-primary`, …) under
`:root` after importing — the components hard-code no colors.

## Components

### `MessageList`

Renders a `NormalizedThreadEntry[]` transcript: user / assistant / system
messages, tool-call activity cards (with status), and plan steps. Optional
streaming: pass `streamingEntryId` + a `subscribeToStream(entryId, onDelta)`
that feeds the *full accumulated text* per delta; the list coalesces deltas
to one paint per frame.

```tsx
<MessageList
  entries={thread.entries}
  streamingEntryId={streamingId}
  subscribeToStream={(id, onDelta) => client.onMessageDelta(id, onDelta)}
  thinking={turnInFlight}
  onRetry={(entryId) => client.retry(entryId)}
/>
```

### `Composer`

The input row. Auto-growing textarea (capped ~40vh), ⏎ submits, ⇧⏎ newline,
IME-safe, with a double-submit guard. While `streaming`, the textarea is
disabled and the send button becomes an Interrupt button.

```tsx
<Composer
  onSubmit={(text) => client.sendUserMessage(text)}
  streaming={turnInFlight}
  onInterrupt={() => client.interrupt()}
  disabled={!connected}
/>
```

### `ChatApprovalModal`

Renders a `NormalizedApprovalRequest` and calls
`onDecision(id, "approved" | "denied" | "abort")`. Escape = deny. Double-
resolve guarded.

```tsx
{approval && (
  <ChatApprovalModal
    request={approval}
    onDecision={(id, decision) => client.answerApproval(id, decision)}
  />
)}
```

## License

MIT © PwrDrvr LLC
