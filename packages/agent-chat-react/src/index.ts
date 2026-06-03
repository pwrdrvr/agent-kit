// @pwrdrvr/agent-chat-react — the presentational React chat kit. Renders
// `@pwrdrvr/agent-core`'s neutral thread shapes and emits user intents
// (submit message, approve/deny an approval, interrupt). NO IPC / bus /
// transport / persistence — a host wires it to `@pwrdrvr/agent-client`.
//
// Ship the styles once in your app:
//   import "@pwrdrvr/agent-chat-react/styles.css";

export { MessageList } from "./MessageList";
export type { MessageListProps, SubscribeToStream } from "./MessageList";

export { Composer } from "./Composer";
export type { ComposerProps } from "./Composer";

export { ChatApprovalModal } from "./ChatApprovalModal";
export type { ChatApprovalModalProps } from "./ChatApprovalModal";
