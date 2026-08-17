// Codex auth status + OAuth login/relogin flow.
//
// Extracted from PwrAgnt's `apps/desktop/src/main/ipc/settings.ts`
// (`collectCodexStatus`, the auth-status check, `parseCodexLoginPrompt`,
// `startCodexProfileLoginProcess`). Two Electron/host seams are broken:
//
//   1. The module logger (`getMainLogger`) → an injected `Logger` from
//      `@pwrdrvr/agent-core`, defaulting to `noopLogger`.
//   2. `shell.openExternal` (Electron) → an injected `OpenExternal` callback,
//      so this file never imports Electron.
//
// The host owns *where* the active login children live by constructing a
// `CodexLoginManager`; re-invoking a login for a profile kills that profile's
// prior child. A module-level default manager is also exported for callers that
// want the PwrAgnt-style global behavior.

import { spawn, type ChildProcess } from "node:child_process";
import {
  type Logger,
  noopLogger,
  type OpenExternal,
} from "@pwrdrvr/agent-core";
import { createCommandInvocation } from "@pwrdrvr/agent-transport";
import { readCodexAuthInfo } from "./codex-profiles";
import type {
  CodexAuthStatusResponse,
  CodexProfileLoginResponse,
} from "./types";

const LOGIN_URL_TIMEOUT_MS = 8_000;

/**
 * Budget for `codex login status`, in ms. Same reasoning as the discovery
 * version probe: the CLI may be an npm `.cmd` shim (`cmd.exe -> node -> shim`)
 * and this one also reads `auth.json` and can touch the network, so it is
 * sized for the slow path. Before this existed the spawn had NO budget — a
 * wedged child hung the caller forever.
 */
export const DEFAULT_CODEX_STATUS_TIMEOUT_MS = 10_000;

/** How a `codex login status` probe ended. `timed_out` says the CLI did not
 *  answer within the budget — NOT that the profile is unauthenticated. */
export type CodexStatusOutcome =
  | "answered"
  | "timed_out"
  | "aborted"
  | "spawn_failed";

export type CodexStatusResult = {
  /** Process exit code; `null` when the CLI never got to report one. */
  code: number | null;
  detail: string;
  outcome: CodexStatusOutcome;
};

export type CollectCodexStatusOptions = {
  /** Defaults to `DEFAULT_CODEX_STATUS_TIMEOUT_MS`. */
  timeoutMs?: number | undefined;
  /** Abandon the probe (app quitting, profile switched away). */
  signal?: AbortSignal | undefined;
};

/**
 * Spawn `codex login status` for a CODEX_HOME and report the raw exit code +
 * combined stdout/stderr. Exit 0 means authenticated.
 *
 * Never hangs: it settles within `timeoutMs`, and `outcome` says whether the
 * CLI actually answered so a caller does not read a slow machine as a signed-
 * out one.
 */
export function collectCodexStatus(
  command: string,
  codexHome: string,
  options: CollectCodexStatusOptions = {},
): Promise<CodexStatusResult> {
  const timeoutMs = Math.max(
    1,
    Math.floor(options.timeoutMs ?? DEFAULT_CODEX_STATUS_TIMEOUT_MS),
  );
  return new Promise((resolve) => {
    if (options.signal?.aborted) {
      resolve({ code: null, detail: "codex login status aborted", outcome: "aborted" });
      return;
    }

    const env = {
      ...process.env,
      CODEX_HOME: codexHome,
    };
    const invocation = createCommandInvocation({
      command,
      args: ["login", "status"],
      env,
    });
    const child = spawn(invocation.command, invocation.args, {
      env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      windowsVerbatimArguments: invocation.windowsVerbatimArguments,
    });
    let output = "";
    let settled = false;
    const settle = (result: CodexStatusResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      resolve(result);
    };
    // Resolve on OUR schedule rather than waiting for the child to die: on
    // Windows the `.cmd` shim runs under `cmd.exe`, so killing it can leave a
    // `node` grandchild holding the pipes open and `close` never fires.
    const abandon = (outcome: "timed_out" | "aborted"): void => {
      child.kill();
      settle({
        code: null,
        detail:
          outcome === "timed_out"
            ? `codex login status did not answer within ${timeoutMs}ms`
            : "codex login status aborted",
        outcome,
      });
    };
    const timer = setTimeout(() => abandon("timed_out"), timeoutMs);
    const onAbort = (): void => abandon("aborted");
    options.signal?.addEventListener("abort", onAbort, { once: true });

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      output += chunk;
    });
    child.stderr.on("data", (chunk) => {
      output += chunk;
    });
    child.on("error", (error) => {
      settle({ code: null, detail: error.message, outcome: "spawn_failed" });
    });
    child.on("close", (code) => {
      settle({ code, detail: output.trim(), outcome: "answered" });
    });
  });
}

/**
 * Resolve a profile's auth status, surfacing JWT-derived identity (email +
 * plan) when authenticated. `codexHome` is the resolved CODEX_HOME for the
 * profile (use `resolveCodexHomeForProfile` / `resolveDefaultCodexHome`).
 */
export async function checkCodexAuthStatus(params: {
  command: string;
  codexHome: string;
  profile: string;
  /** Budget for the `codex login status` spawn. Defaults to
   *  `DEFAULT_CODEX_STATUS_TIMEOUT_MS`. */
  timeoutMs?: number | undefined;
  signal?: AbortSignal | undefined;
}): Promise<CodexAuthStatusResponse> {
  const result = await collectCodexStatus(params.command, params.codexHome, {
    timeoutMs: params.timeoutMs,
    signal: params.signal,
  });
  const authenticated = result.code === 0;
  const authInfo = authenticated ? readCodexAuthInfo(params.codexHome) : {};
  return {
    profile: params.profile,
    codexHome: params.codexHome,
    authenticated,
    status:
      result.code === null
        ? "failed"
        : authenticated
          ? "authenticated"
          : "unauthenticated",
    // `failed` alone reads as "this profile is broken". Flagging the timeout
    // lets a host say "couldn't check in time" and retry instead.
    ...(result.outcome === "timed_out" ? { timedOut: true } : {}),
    ...(result.detail ? { detail: result.detail } : {}),
    ...(authInfo.email ? { email: authInfo.email } : {}),
    ...(authInfo.planType ? { planType: authInfo.planType } : {}),
  };
}

export function parseCodexLoginPrompt(output: string): { loginUrl?: string } {
  const loginUrl = output.match(
    /https:\/\/auth\.openai\.com\/oauth\/authorize\S+/,
  )?.[0];
  return loginUrl ? { loginUrl } : {};
}

export type CodexLoginManagerOptions = {
  logger?: Logger;
  /** Opens the scraped OAuth URL in the user's browser (host injects
   *  Electron `shell.openExternal`). Defaults to a no-op so the flow never
   *  imports Electron and stays testable. */
  openExternal?: OpenExternal;
  /** How long to wait for the login prompt's OAuth URL before resolving with
   *  `started: true` anyway. Defaults to 8s; tests set it small. */
  loginUrlTimeoutMs?: number;
  /** Budget for the `codex login status` re-check run when a login child
   *  exits. Defaults to `DEFAULT_CODEX_STATUS_TIMEOUT_MS`. */
  statusTimeoutMs?: number;
};

export type StartCodexLoginParams = {
  codexHome: string;
  command: string;
  profile: string;
};

/**
 * Tracks active `codex login` children keyed by profile so a re-login for a
 * profile kills the prior child first. The host constructs one of these (it
 * decides the lifetime + cleanup); `dispose()` kills every tracked child.
 */
export class CodexLoginManager {
  private readonly logger: Logger;
  private readonly openExternal: OpenExternal;
  private readonly loginUrlTimeoutMs: number;
  private readonly statusTimeoutMs: number;
  private readonly activeLoginProcesses = new Map<string, ChildProcess>();

  constructor(options: CodexLoginManagerOptions = {}) {
    this.logger = options.logger ?? noopLogger;
    this.openExternal = options.openExternal ?? (async () => {});
    this.loginUrlTimeoutMs = options.loginUrlTimeoutMs ?? LOGIN_URL_TIMEOUT_MS;
    this.statusTimeoutMs = options.statusTimeoutMs ?? DEFAULT_CODEX_STATUS_TIMEOUT_MS;
  }

  /**
   * Spawn `codex login` for a profile's CODEX_HOME, scrape the OAuth URL,
   * hand it to the injected `OpenExternal`, and resolve. If no URL surfaces
   * within ~8s the promise resolves anyway with `started: true` and whatever
   * detail was captured. On child close, re-checks status and resolves
   * authenticated if `codex login status` exits 0.
   */
  startProfileLogin(
    params: StartCodexLoginParams,
  ): Promise<CodexProfileLoginResponse> {
    this.activeLoginProcesses.get(params.profile)?.kill();
    return new Promise((resolve, reject) => {
      const env = {
        ...process.env,
        CODEX_HOME: params.codexHome,
      };
      const invocation = createCommandInvocation({
        command: params.command,
        args: ["login"],
        env,
      });
      const child = spawn(invocation.command, invocation.args, {
        env,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
        windowsVerbatimArguments: invocation.windowsVerbatimArguments,
      });
      this.activeLoginProcesses.set(params.profile, child);

      let output = "";
      let settled = false;
      const timeout = setTimeout(() => {
        if (settled) return;
        settled = true;
        const prompt = parseCodexLoginPrompt(output);
        this.logger.warn("codex login prompt did not appear before timeout", {
          profile: params.profile,
          pid: child.pid,
        });
        resolve({
          profile: params.profile,
          codexHome: params.codexHome,
          started: true,
          ...(child.pid !== undefined ? { pid: child.pid } : {}),
          ...prompt,
          ...(output.trim() ? { detail: output.trim() } : {}),
        });
      }, this.loginUrlTimeoutMs);

      const maybeResolve = (): void => {
        if (settled) return;
        const prompt = parseCodexLoginPrompt(output);
        if (!prompt.loginUrl) return;
        settled = true;
        clearTimeout(timeout);
        void this.openExternal(prompt.loginUrl).catch((error: unknown) => {
          this.logger.warn("failed to open codex login URL", {
            error: error instanceof Error ? error.message : String(error),
            profile: params.profile,
          });
        });
        resolve({
          profile: params.profile,
          codexHome: params.codexHome,
          started: true,
          ...(child.pid !== undefined ? { pid: child.pid } : {}),
          ...prompt,
          detail: output.trim(),
        });
      };

      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk) => {
        output += chunk;
        maybeResolve();
      });
      child.stderr.on("data", (chunk) => {
        output += chunk;
        maybeResolve();
      });
      child.on("error", (error) => {
        if (!settled) {
          settled = true;
          clearTimeout(timeout);
          reject(error);
        }
      });
      child.on("close", (code) => {
        if (this.activeLoginProcesses.get(params.profile) === child) {
          this.activeLoginProcesses.delete(params.profile);
        }
        if (!settled) {
          settled = true;
          clearTimeout(timeout);
          void (async () => {
            const status = await collectCodexStatus(
              params.command,
              params.codexHome,
              { timeoutMs: this.statusTimeoutMs },
            );
            if (status.code === 0) {
              resolve({
                profile: params.profile,
                codexHome: params.codexHome,
                started: false,
                ...(child.pid !== undefined ? { pid: child.pid } : {}),
                authenticated: true,
                ...(status.detail ? { detail: status.detail } : {}),
              });
              return;
            }
            reject(
              new Error(
                output.trim()
                  || status.detail
                  || `Codex login exited before emitting a login link (code ${code ?? "unknown"}).`,
              ),
            );
          })();
        }
      });
    });
  }

  /** Kill every tracked login child. Call on host shutdown. */
  dispose(): void {
    for (const child of this.activeLoginProcesses.values()) {
      child.kill();
    }
    this.activeLoginProcesses.clear();
  }
}

/**
 * Convenience that mirrors PwrAgnt's module-level
 * `startCodexProfileLoginProcess`: a default manager keyed by profile across
 * calls. Pass `manager` to scope tracking to a host-owned instance instead.
 */
export function startCodexProfileLoginProcess(
  params: StartCodexLoginParams,
  options?: CodexLoginManagerOptions & { manager?: CodexLoginManager },
): Promise<CodexProfileLoginResponse> {
  const manager =
    options?.manager
    ?? new CodexLoginManager({
      ...(options?.logger ? { logger: options.logger } : {}),
      ...(options?.openExternal ? { openExternal: options.openExternal } : {}),
      ...(options?.loginUrlTimeoutMs !== undefined
        ? { loginUrlTimeoutMs: options.loginUrlTimeoutMs }
        : {}),
      ...(options?.statusTimeoutMs !== undefined
        ? { statusTimeoutMs: options.statusTimeoutMs }
        : {}),
    });
  return manager.startProfileLogin(params);
}
