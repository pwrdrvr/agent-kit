// Hydrate a process environment from an interactive login shell.
//
// A GUI app launched from Finder / Dock / `open` (macOS) or a desktop launcher
// (Linux) inherits a minimal environment — `PATH` is the system default, with
// none of the nvm / Homebrew / asdf additions a user's shell rc sets up. So a
// CLI installed via `npm i -g` under nvm (e.g. an ACP agent like `qwen`, or a
// `codex` build) is invisible: bare-command `execFile("qwen", …)` resolves
// against the impoverished `PATH` and fails, while a tool installed to a fixed
// absolute path is still found.
//
// Fix: spawn the user's interactive login shell, capture its `env`, and merge
// it in. Every later spawn (ACP agent discovery, Codex discovery / spawn, …)
// then sees the real `PATH`.
//
// This is the shared implementation every @pwrdrvr desktop host calls at
// startup — the discovery packages just read `process.env`, so hydrating it
// once upstream covers both ACP and Codex. Lives in agent-transport because it
// is node-only process plumbing (the sibling of stdio-transport's spawn), not
// schema (agent-core stays browser-safe) and not ACP-/Codex-specific.

import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { noopLogger, type Logger } from "@pwrdrvr/agent-core";

type ExecFileSyncLike = (
  file: string,
  args: string[],
  options: {
    encoding: BufferEncoding;
    env: NodeJS.ProcessEnv;
    stdio: ["ignore", "pipe", "ignore"];
    timeout: number;
  }
) => string;

export type ResolveLoginShellEnvOptions = {
  /** Base env passed to the spawned shell (defaults to `process.env`). */
  env?: NodeJS.ProcessEnv;
  /** Platform override (defaults to `process.platform`); `win32` is a no-op. */
  platform?: NodeJS.Platform;
  /** Injectable `execFileSync` for tests. */
  execFileSync?: ExecFileSyncLike;
  /** Shell binaries to try, in order (defaults to `$SHELL`, the user's shell, zsh, bash). */
  shellCandidates?: string[];
  /** Per-shell timeout in ms (default 5000). */
  timeoutMs?: number;
  /** Host logger; defaults to no-op. */
  logger?: Logger;
};

export type MergeLoginShellEnvOptions = ResolveLoginShellEnvOptions & {
  /** Inject the resolved shell env directly (tests). Bypasses spawning. */
  resolveShellEnv?: (env: NodeJS.ProcessEnv) => NodeJS.ProcessEnv | undefined;
};

/**
 * Return a COPY of `env` with the absolute `command`'s own directory prepended
 * to `PATH`. No-op for a bare command name or when the dir is already on `PATH`.
 *
 * Why: a CLI installed by a node version manager is a Node script
 * (`#!/usr/bin/env node`) living next to its `node` binary (e.g.
 * `~/.nvm/versions/node/v24/bin/{qwen,node}`). Spawning the script with a
 * `PATH` that lacks that `node` fails with `env: node: No such file or
 * directory`. Prepending the executable's own dir guarantees the matching
 * `node` (and other siblings) resolve — for both discovery probes and the
 * real agent spawn.
 */
export function prependCommandDirToPath(
  command: string,
  env: NodeJS.ProcessEnv
): NodeJS.ProcessEnv {
  if (!path.isAbsolute(command)) return env;
  const dir = path.dirname(command);
  const key = env.Path !== undefined && env.PATH === undefined ? "Path" : "PATH";
  const current = env[key] ?? "";
  if (current.split(path.delimiter).includes(dir)) return env;
  return {
    ...env,
    [key]: current.length > 0 ? dir + path.delimiter + current : dir
  };
}

const ENV_MARKER_START = "__PWRDRVR_ENV_START__";
const ENV_MARKER_END = "__PWRDRVR_ENV_END__";
const DEFAULT_SHELL_PATH_TIMEOUT_MS = 5_000;

/**
 * Mutate `process.env` in place with the interactive login shell's environment
 * so bare-command spawns resolve against the user's real `PATH`. No-op on
 * Windows and when the shell can't be queried. Call once, early, at startup.
 */
export function hydrateProcessEnvFromLoginShell(
  options: MergeLoginShellEnvOptions = {}
): void {
  const merged = mergeLoginShellEnvIntoEnv(process.env, options);
  if (merged !== process.env) {
    Object.assign(process.env, merged);
  }
}

/** Return a COPY of `env` overlaid with the interactive login shell's env.
 *  Returns `env` unchanged (same reference) when nothing could be resolved. */
export function mergeLoginShellEnvIntoEnv(
  env: NodeJS.ProcessEnv,
  options: MergeLoginShellEnvOptions = {}
): NodeJS.ProcessEnv {
  const platform = options.platform ?? process.platform;
  const logger = options.logger ?? noopLogger;
  const shellEnv = options.resolveShellEnv
    ? options.resolveShellEnv(env)
    : resolveInteractiveLoginShellEnv({ ...options, env, platform });
  if (!shellEnv || Object.keys(shellEnv).length === 0) {
    // Silent hydration failure is a likely root cause when a tool works from a
    // terminal-launched dev build but is invisible to a Finder-launched
    // bundle. Log enough to diagnose without leaking sensitive env values.
    logger.warn("login-shell-env-merge-empty", {
      platform,
      shellCandidates: defaultShellCandidates(env),
      parentShell: env.SHELL,
      parentPathLength: env.PATH?.length ?? 0
    });
    return env;
  }
  logger.info("login-shell-env-merged", {
    keys: Object.keys(shellEnv).length,
    parentPathLength: env.PATH?.length ?? 0,
    hydratedPathLength: shellEnv.PATH?.length ?? 0,
    hadNvmDir: Boolean(shellEnv.NVM_DIR),
    hadHomebrewPrefix: Boolean(shellEnv.HOMEBREW_PREFIX)
  });
  return { ...env, ...shellEnv };
}

/** Spawn the user's interactive login shell and parse its `env`. Returns the
 *  parsed env, or undefined on Windows / when no shell could report it. */
export function resolveInteractiveLoginShellEnv(
  options: ResolveLoginShellEnvOptions = {}
): NodeJS.ProcessEnv | undefined {
  const platform = options.platform ?? process.platform;
  if (platform === "win32") {
    return undefined;
  }

  const env = options.env ?? process.env;
  const logger = options.logger ?? noopLogger;
  const exec: ExecFileSyncLike =
    options.execFileSync ??
    ((file, args, execOptions) => String(execFileSync(file, args, execOptions)));
  const timeout = options.timeoutMs ?? DEFAULT_SHELL_PATH_TIMEOUT_MS;
  const command = [
    `command printf '${ENV_MARKER_START}\\n'`,
    "command env",
    `command printf '${ENV_MARKER_END}\\n'`
  ].join("; ");

  const failures: Array<{ shell: string; message: string }> = [];
  for (const shell of options.shellCandidates ?? defaultShellCandidates(env)) {
    try {
      const output = exec(shell, ["-ilc", command], {
        encoding: "utf8",
        env,
        stdio: ["ignore", "pipe", "ignore"],
        timeout
      });
      const shellEnv = extractMarkedEnv(output);
      if (shellEnv) {
        return shellEnv;
      }
      failures.push({ shell, message: "empty-env-output" });
    } catch (error) {
      failures.push({
        shell,
        message: error instanceof Error ? error.message : String(error)
      });
    }
  }

  if (failures.length > 0) {
    logger.warn("login-shell-env-resolve-failed", {
      attempts: failures.length,
      failures: failures.map((entry) => `${entry.shell}:${entry.message}`).join("; "),
      timeoutMs: timeout
    });
  }
  return undefined;
}

function defaultShellCandidates(env: NodeJS.ProcessEnv): string[] {
  const candidates = [env.SHELL, readUserShell(), "/bin/zsh", "/bin/bash"];
  return [...new Set(candidates.filter(isUsableShellPath))];
}

function readUserShell(): string | undefined {
  try {
    return os.userInfo().shell ?? undefined;
  } catch {
    return undefined;
  }
}

function isUsableShellPath(value: string | undefined): value is string {
  if (!value?.trim()) {
    return false;
  }
  return path.isAbsolute(value);
}

function extractMarkedEnv(output: string): NodeJS.ProcessEnv | undefined {
  const start = output.indexOf(ENV_MARKER_START);
  if (start === -1) {
    return undefined;
  }
  const valueStart = start + ENV_MARKER_START.length;
  const end = output.indexOf(ENV_MARKER_END, valueStart);
  if (end === -1) {
    return undefined;
  }
  const env: NodeJS.ProcessEnv = {};
  for (const line of output.slice(valueStart, end).split(/\r?\n/)) {
    const separator = line.indexOf("=");
    if (separator <= 0) {
      continue;
    }
    const key = line.slice(0, separator);
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      continue;
    }
    env[key] = line.slice(separator + 1);
  }
  return Object.keys(env).length > 0 ? env : undefined;
}
