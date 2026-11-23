// Spawns a command and shuttles JSON-RPC envelopes line-delimited over stdio.
// Generic: the caller provides the fully-resolved command + args (the Codex
// adapter passes a discovered binary + ["app-server"]; an ACP adapter passes
// the agent binary + its stdio subcommand). No discovery or product coupling.

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { type Logger, noopLogger } from "@pwrdrvr/agent-core";
import { createCommandInvocation } from "./command-launch";
import type { JsonRpcTransport } from "./json-rpc";
import { readJsonRpcLines } from "./json-rpc-lines";
import { prependCommandDirToPath } from "./shell-env";

export type StdioJsonRpcTransportOptions = {
  /** Fully-resolved executable path or command name. */
  command: string;
  /** Arguments, e.g. ["app-server"] for Codex or ["agent", "stdio"] for an ACP agent. */
  args?: string[];
  env?: NodeJS.ProcessEnv;
  logger?: Logger;
};

export class StdioJsonRpcTransport implements JsonRpcTransport {
  private active: {
    child: ChildProcessWithoutNullStreams;
    stopReading: () => void;
  } | null = null;
  private messageHandler: (message: string) => void = () => undefined;
  private closeHandler: (error?: Error) => void = () => undefined;
  private readonly logger: Logger;

  constructor(private readonly options: StdioJsonRpcTransportOptions) {
    this.logger = options.logger ?? noopLogger;
  }

  setMessageHandler(handler: (message: string) => void): void {
    this.messageHandler = handler;
  }

  setCloseHandler(handler: (error?: Error) => void): void {
    this.closeHandler = handler;
  }

  async connect(): Promise<void> {
    if (this.active) {
      return;
    }

    // Prepend the command's own dir to PATH so a node-version-manager CLI
    // (a Node script) finds its sibling `node` even when launched from a
    // GUI app's minimal PATH.
    const env = prependCommandDirToPath(this.options.command, this.options.env ?? process.env);
    const args = this.options.args ?? [];
    const invocation = createCommandInvocation({
      command: this.options.command,
      args,
      env
    });
    this.logger.info("agent-transport launch", {
      command: this.options.command,
      args: args.join(" ")
    });

    const child = spawn(invocation.command, invocation.args, {
      stdio: ["pipe", "pipe", "pipe"],
      env,
      windowsVerbatimArguments: invocation.windowsVerbatimArguments
    });

    if (!child.stdin || !child.stdout || !child.stderr) {
      throw new Error("agent stdio pipes unavailable");
    }

    // Keep error listeners for the lifetime of the child and its pipes. Node
    // can emit a stream error even after a failed write callback or close().
    const onError = (error: Error): void => this.disconnect(child, true, error);
    child.on("error", onError);
    child.stdin.on("error", onError);
    child.stdout.on("error", onError);
    child.stderr.on("error", onError);
    child.once("close", () => this.disconnect(child, false));

    const stopReading = readJsonRpcLines(child.stdout, (line) => {
      if (this.active?.child === child) this.messageHandler(line);
    });
    this.active = { child, stopReading };

    // Drain stderr so the child never blocks on a full pipe.
    child.stderr.on("data", () => undefined);
  }

  async close(): Promise<void> {
    const child = this.active?.child;
    if (child) this.disconnect(child, true);
  }

  send(message: string): void {
    const child = this.active?.child;
    if (!child) {
      throw new Error("agent stdio not connected");
    }

    try {
      child.stdin.write(`${message}\n`, (error) => {
        if (error) this.disconnect(child, true, error);
      });
    } catch (error) {
      this.disconnect(child, true, error instanceof Error ? error : new Error(String(error)));
      throw error;
    }
  }

  private disconnect(
    child: ChildProcessWithoutNullStreams,
    terminate: boolean,
    error?: Error
  ): void {
    const active = this.active;
    if (active?.child !== child) return;

    this.active = null;
    active.stopReading();
    try {
      if (terminate && child.exitCode == null && child.signalCode == null && !child.killed) {
        child.kill();
      }
    } finally {
      this.closeHandler(error);
    }
  }
}
