// The bidirectional seam the ACP clients (`AcpAgentClient`, `AcpOneShotClient`,
// the pool) drive: send a request / notification, listen for agent→client
// notifications, answer agent→client requests. The concrete implementation is
// `AcpConnection` (over the official ACP library); tests inject a fake.
//
// Kept as a tiny standalone module so the clients depend on the SEAM, not on the
// connection implementation (which pulls in the heavy ACP library).

import type { JsonRpcId } from "@pwrdrvr/agent-transport";

export interface AcpJsonRpcTransport {
  request(
    method: string,
    params?: Record<string, unknown>,
    timeoutMs?: number
  ): Promise<unknown>;
  notify?(method: string, params?: Record<string, unknown>): Promise<void>;
  close?(): Promise<void>;
  onNotification(
    listener: (method: string, params: Record<string, unknown>) => void
  ): () => void;
  onRequest?(
    listener: (
      method: string,
      params: Record<string, unknown>,
      id?: JsonRpcId
    ) => Promise<unknown> | unknown
  ): () => void;
}
