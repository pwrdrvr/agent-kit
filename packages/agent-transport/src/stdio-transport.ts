// Spawns a command and shuttles JSON-RPC envelopes line-delimited over stdio.
// Generic: the caller provides the fully-resolved command + args (the Codex
// adapter passes a discovered binary + ["app-server"]; an ACP adapter passes
// the agent binary + its stdio subcommand). No discovery or product coupling.

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import readline from "node:readline";
import { type Logger, noopLogger } from "@pwrdrvr/agent-core";
import type { JsonRpcTransport } from "./json-rpc";

export type StdioJsonRpcTransportOptions = {
  /** Fully-resolved executable path or command name. */
  command: string;
  /** Arguments, e.g. ["app-server"] for Codex or ["agent", "stdio"] for an ACP agent. */
  args?: string[];
  env?: NodeJS.ProcessEnv;
  logger?: Logger;
};

export class StdioJsonRpcTransport implements JsonRpcTransport {
  private childProcess: ChildProcessWithoutNullStreams | null = null;
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
    if (this.childProcess) {
      return;
    }

    const env = this.options.env ?? process.env;
    const args = this.options.args ?? [];
    this.logger.info("agent-transport launch", {
      command: this.options.command,
      args: args.join(" ")
    });

    const child = spawn(this.options.command, args, {
      stdio: ["pipe", "pipe", "pipe"],
      env
    });

    if (!child.stdin || !child.stdout || !child.stderr) {
      throw new Error("agent stdio pipes unavailable");
    }

    this.childProcess = child;

    const stdoutReader = readline.createInterface({ input: child.stdout });
    stdoutReader.on("line", (line: string) => {
      this.messageHandler(line);
    });

    // Drain stderr so the child never blocks on a full pipe.
    child.stderr.on("data", () => undefined);
    child.on("error", (error: Error) => {
      this.closeHandler(error);
    });
    child.on("close", () => {
      this.childProcess = null;
      this.closeHandler();
    });
  }

  async close(): Promise<void> {
    const child = this.childProcess;
    this.childProcess = null;
    if (!child) {
      return;
    }
    child.kill();
  }

  send(message: string): void {
    const child = this.childProcess;
    if (!child?.stdin) {
      throw new Error("agent stdio not connected");
    }
    child.stdin.write(`${message}\n`);
  }
}
