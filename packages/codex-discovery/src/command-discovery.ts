// Generic command-discovery engine: PATH resolution (incl. Windows PATHEXT),
// executability checks, a timed version probe, dedup/merge, and the documented
// `env > config > best-auto` selection priority. Kept backend-agnostic — Codex
// specifics live in `codex-discovery.ts`.
//
// Ported from PwrAgnt (apps/desktop/src/main/settings/command-discovery.ts).
// The version probe has since diverged deliberately: its budget is configurable
// and larger, it settles within that budget, it can be cancelled, and it says
// WHY it ended (see `CommandVersionProbeOutcome`) so a slow machine is never
// reported as a machine without the tool installed.
//
// Windows name resolution has diverged too: PATHEXT variants are tried instead
// of the bare command name, and executability is judged by extension rather
// than by `access(X_OK)` — see `buildPathCommandNames` and `pathIsExecutable`.

import { execFile as execFileCallback } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { access } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { createCommandInvocation } from "@pwrdrvr/agent-transport";

const execFile = promisify(execFileCallback);

// NOTE: the optional fields explicitly allow `| undefined` because the
// builders below assign `version: undefined` etc. directly into object
// literals, and the kit's tsconfig enables `exactOptionalPropertyTypes`.
// PwrAgnt's tsconfig did not, so this is a type-only accommodation — the
// runtime shapes are identical.
/**
 * Budget for a single `<command> --version` probe, in ms.
 *
 * Sized for the SLOWEST realistic launch path, not the fastest. Measured
 * against a real Codex 0.146.0 install on Windows: a native `codex.exe`
 * answers in ~0.3s, but npm's `codex.cmd` is a `cmd.exe -> node -> shim`
 * chain that needs ~1.5s WARM — and several times that cold, or on a loaded
 * machine. The previous hardcoded 2s sat right on top of that number.
 *
 * Overrunning is not a "slow" result, it is a WRONG one: the candidate comes
 * back without a version, and every version-gating consumer reads that as
 * "this tool is not installed". So the default buys headroom for the shim
 * chain rather than matching what a native binary needs; a host that wants a
 * snappier first paint can lower it and re-probe on its own budget.
 */
export const DEFAULT_COMMAND_VERSION_TIMEOUT_MS = 10_000;

/** `CommandDiscoverySnapshot.error` when a caller's `AbortSignal` fired. */
export const COMMAND_DISCOVERY_ABORTED = "discovery_aborted";

/**
 * Why a `--version` probe ended. The point of the enum is that `timed_out` is
 * NOT `not_found`: a probe that overran its budget says nothing about whether
 * the command exists, so a consumer can re-probe on a larger budget (or say
 * "could not verify") instead of reporting the tool as missing.
 */
export type CommandVersionProbeOutcome =
  /** Ran and reported a parseable version. */
  | "ok"
  /** Ran, but nothing in stdout/stderr parsed as a version. */
  | "version_not_reported"
  /** The command does not exist (ENOENT / ENOTDIR). */
  | "not_found"
  /** The command exists but could not be executed (EACCES / EPERM). */
  | "not_executable"
  /** The probe exceeded its budget. Says NOTHING about installedness. */
  | "timed_out"
  /** The caller's `AbortSignal` fired. Says NOTHING about installedness. */
  | "aborted"
  /** Ran and failed some other way (non-zero exit, spawn error, …). */
  | "failed";

/**
 * True for the outcomes that carry NO evidence about the command: the probe
 * did not get to run to completion, so "no version" means "unknown", not
 * "absent". Callers should re-probe (or say "could not verify") rather than
 * treat these as a failed or missing tool.
 */
export function isUnprovenVersionProbe(
  outcome: CommandVersionProbeOutcome | undefined,
): boolean {
  return outcome === "timed_out" || outcome === "aborted";
}

export type CommandVersionProbeResult = {
  outcome: CommandVersionProbeOutcome;
  /** True only when the command actually executed to completion. */
  ran: boolean;
  version?: string | undefined;
  /** Machine-readable reason string mirrored onto the discovery candidate. */
  failureReason?: string | undefined;
  /** Budget this probe was given — echoed so a retrying caller knows what
   *  already proved too small. Absent when no probe was spawned. */
  timeoutMs?: number | undefined;
};

export type CommandDiscoveryCandidate<Source extends string> = {
  command: string;
  source: Source;
  executable: boolean;
  selected: boolean;
  version?: string | undefined;
  versionFailureReason?: string | undefined;
  failureReason?: string | undefined;
  /** Outcome of this candidate's `--version` probe, when one was attempted.
   *  `timed_out` / `aborted` mean the version is UNKNOWN, not absent — a
   *  version-gating consumer should re-probe rather than demote the
   *  candidate to "not installed". */
  versionProbeOutcome?: CommandVersionProbeOutcome | undefined;
};

export type CommandDiscoverySnapshot<Source extends string> = {
  selectedCommand?: string | undefined;
  selectedSource?: Source | undefined;
  candidates: Array<CommandDiscoveryCandidate<Source>>;
  /** `COMMAND_DISCOVERY_ABORTED` when the caller's signal fired; any
   *  candidates already probed are still returned. */
  error?: string | undefined;
};

export type CommandDiscoveryInput<Source extends string> = {
  command: string | undefined;
  source: Source;
};

export type DiscoverCommandOptions<Source extends string> = {
  fixedCandidates: Array<CommandDiscoveryInput<Source>>;
  autoCandidates: Array<CommandDiscoveryInput<Source>>;
  env: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform | undefined;
  versionArgs?: string[] | undefined;
  parseVersion: (output: string) => string | undefined;
  compareVersions?: ((left?: string, right?: string) => number) | undefined;
  validateVersion?: ((version: string) => string | undefined) | undefined;
  preflightCandidate?: ((params: {
    command: string;
    source: Source;
    env: NodeJS.ProcessEnv;
    platform: NodeJS.Platform;
    signal?: AbortSignal | undefined;
  }) => Promise<CommandDiscoveryPreflightResult | undefined>) | undefined;
  includeFailedAutoCandidates?: boolean | "if-none-executable" | undefined;
  /** Per-candidate `--version` budget. Defaults to
   *  `DEFAULT_COMMAND_VERSION_TIMEOUT_MS`. */
  versionTimeoutMs?: number | undefined;
  /** Abandon in-flight probes — discovery re-triggered while the previous run
   *  is still going, or the app quitting mid-probe. Aborting yields a snapshot
   *  with `error: COMMAND_DISCOVERY_ABORTED` rather than a rejection. */
  signal?: AbortSignal | undefined;
};

export type CommandDiscoveryPreflightResult = {
  version?: string | undefined;
  failureReason?: string | undefined;
  versionFailureReason?: string | undefined;
  skipVersionProbe?: boolean | undefined;
};

export type ResolvedCommandCandidate<Source extends string> = {
  command: string;
  source: Source;
  version?: string | undefined;
  /** Why the selected candidate's `--version` probe ended. A resolved command
   *  with NO version and `versionProbeOutcome: "timed_out"` is a machine that
   *  answered too slowly, not one missing the tool. */
  versionProbeOutcome?: CommandVersionProbeOutcome | undefined;
};

function isNotFoundError(error: unknown): boolean {
  const code = (error as { code?: unknown } | undefined)?.code;
  return code === "ENOENT" || code === "ENOTDIR";
}

function isPermissionError(error: unknown): boolean {
  const code = (error as { code?: unknown } | undefined)?.code;
  return code === "EACCES" || code === "EPERM";
}

/** `execFile` sets `killed` when IT tore the child down — i.e. its own
 *  `timeout` elapsed. Distinguishes an overrun from a normal failed exit. */
function wasKilledByExecFile(error: unknown): boolean {
  return (error as { killed?: unknown } | undefined)?.killed === true;
}

async function pathExists(candidate: string): Promise<"exists" | "not_found" | "unknown"> {
  try {
    await access(candidate, fsConstants.F_OK);
    return "exists";
  } catch (error) {
    return isNotFoundError(error) ? "not_found" : "unknown";
  }
}

export type PathIsExecutableOptions = {
  env?: NodeJS.ProcessEnv | undefined;
  platform?: NodeJS.Platform | undefined;
};

/**
 * Is this path something the OS could actually launch?
 *
 * POSIX asks the filesystem (`X_OK`). Windows cannot: it has no execute bit,
 * so `access(X_OK)` degrades to `F_OK` and answers "true" for every file that
 * exists — a README included. There, startability is carried by the EXTENSION
 * instead, which is the same rule `CreateProcess` and `cmd.exe` apply, so we
 * check the name against PATHEXT and confirm existence separately.
 *
 * `options` is optional purely for back-compat with the original
 * `pathIsExecutable(path)` signature; without it the win32 branch falls back
 * to `process.env` and the default PATHEXT.
 */
export async function pathIsExecutable(
  candidate: string,
  options?: PathIsExecutableOptions,
): Promise<boolean> {
  const platform = options?.platform ?? process.platform;
  if (platform === "win32") {
    if (!hasExecutableExtension(candidate, options?.env ?? process.env)) {
      return false;
    }
    return (await pathExists(candidate)) === "exists";
  }

  try {
    await access(candidate, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function commandHasPathSeparator(command: string): boolean {
  return command.includes("/") || command.includes("\\");
}

/** Windows env vars are case-insensitive; a synthesized env may spell it
 *  `Path` / `PathExt`. Look the name up case-insensitively there. */
function readWindowsEnv(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const key = Object.keys(env).find(
    (candidate) => candidate.toLowerCase() === name.toLowerCase(),
  );
  return key ? env[key] : undefined;
}

function readPathEnv(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string | undefined {
  if (platform !== "win32") {
    return env.PATH;
  }

  return readWindowsEnv(env, "PATH");
}

/** PATHEXT split into normalized, dot-prefixed extensions. The fallback is the
 *  Windows default for a machine that somehow has no PATHEXT set. */
function readPathExtensions(env: NodeJS.ProcessEnv): string[] {
  const rawExtensions = readWindowsEnv(env, "PATHEXT")?.trim() || ".COM;.EXE;.BAT;.CMD";
  return rawExtensions
    .split(";")
    .map((extension) => extension.trim())
    .filter(Boolean)
    .map((extension) => (extension.startsWith(".") ? extension : `.${extension}`));
}

function hasExecutableExtension(candidate: string, env: NodeJS.ProcessEnv): boolean {
  const extension = path.win32.extname(candidate).toLowerCase();
  return (
    extension.length > 0
    && readPathExtensions(env).some((known) => known.toLowerCase() === extension)
  );
}

function normalizePathEntry(entry: string): string {
  const trimmed = entry.trim();
  const quoted = trimmed.match(/^"(.+)"$/);
  return quoted?.[1] ?? trimmed;
}

/**
 * The filenames to look for, in the order the PATH scan should try them.
 *
 * ORDER IS THE WHOLE POINT ON WINDOWS. npm installs three shims side by side —
 * `codex` (an sh script, for Git Bash), `codex.cmd`, and `codex.ps1` — so any
 * npm / nvm-windows bin dir contains an extensionless file with the command's
 * exact name. That file is not startable on Windows: `CreateProcess` (and so
 * `child_process`) appends `.exe` to an extensionless name, and PATHEXT is how
 * the OS decides what a name means. Trying the bare name first therefore
 * stopped the scan on the sh script and never reached `codex.cmd`, reporting a
 * present, working tool as missing.
 *
 * So on win32 the bare name is not a candidate at all — with one exception: a
 * command that carries some OTHER extension (`tool.ps1`) names a specific file
 * the caller asked for, and is kept as a last resort so it stays discoverable.
 *
 * POSIX is unchanged: the bare name is correct and the only option there.
 *
 * Package-internal (not re-exported from the index): exported only so the
 * ordering can be asserted on a non-Windows host, where the real PATH scan's
 * `path.win32.join` cannot match a POSIX temp file.
 */
export function buildPathCommandNames(
  command: string,
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
): string[] {
  if (platform !== "win32") {
    return [command];
  }

  // Already a launchable name (`codex.cmd`) — nothing to expand.
  if (hasExecutableExtension(command, env)) {
    return [command];
  }

  const expanded = readPathExtensions(env).map((extension) => `${command}${extension}`);
  return path.win32.extname(command) ? [...expanded, command] : expanded;
}

async function resolvePathCommand(
  command: string,
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
): Promise<string | undefined> {
  if (commandHasPathSeparator(command)) {
    return command;
  }

  const pathValue = readPathEnv(env, platform);
  if (!pathValue?.trim()) {
    return undefined;
  }

  const delimiter = platform === "win32" ? ";" : path.delimiter;
  const joinPath = platform === "win32" ? path.win32.join : path.join;
  const commandNames = buildPathCommandNames(command, env, platform);

  for (const directory of pathValue
    .split(delimiter)
    .map(normalizePathEntry)
    .filter(Boolean)) {
    for (const commandName of commandNames) {
      const candidate = joinPath(directory, commandName);
      if (await pathExists(candidate) !== "not_found") {
        return candidate;
      }
    }
  }

  return undefined;
}

export type ReadCommandVersionOptions = {
  command: string;
  env: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform | undefined;
  parseVersion: (output: string) => string | undefined;
  /** Defaults to `["--version"]`. */
  versionArgs?: string[] | undefined;
  /** Defaults to `DEFAULT_COMMAND_VERSION_TIMEOUT_MS`. Values below 1ms are
   *  clamped up; the probe always settles within the budget. */
  timeoutMs?: number | undefined;
  signal?: AbortSignal | undefined;
};

/**
 * Clamp a caller-supplied budget to something a timer can actually honor.
 *
 * The `Number.isFinite` guard is load-bearing, not defensive: `Infinity` is the
 * natural spelling of "no budget", and both consumers of the result reject it —
 * `setTimeout` silently collapses a non-finite delay to 1ms, and `execFile`'s
 * `timeout` option throws `ERR_OUT_OF_RANGE` synchronously. Either way a
 * caller asking for "no limit" would get "no time at all".
 *
 * Package-internal (not re-exported from the index) so every budget in this
 * package answers to one policy.
 */
export function normalizeTimeoutMs(
  timeoutMs: number | undefined,
  fallbackMs: number,
): number {
  if (timeoutMs === undefined || !Number.isFinite(timeoutMs)) {
    return fallbackMs;
  }
  return Math.max(1, Math.floor(timeoutMs));
}

function normalizeVersionTimeoutMs(timeoutMs: number | undefined): number {
  return normalizeTimeoutMs(timeoutMs, DEFAULT_COMMAND_VERSION_TIMEOUT_MS);
}

function cancelledVersionProbe(
  outcome: "timed_out" | "aborted",
  timeoutMs: number,
): CommandVersionProbeResult {
  return {
    outcome,
    ran: false,
    failureReason:
      outcome === "timed_out" ? "version_probe_timed_out" : "version_probe_aborted",
    timeoutMs,
  };
}

/**
 * Run `<command> --version` and report BOTH the parsed version and why the
 * probe ended. Exported so a host can re-probe a candidate on its own budget
 * after discovery reported `timed_out`, without re-implementing the Windows
 * shim quoting in `createCommandInvocation`.
 *
 * The budget is authoritative: the probe resolves within `timeoutMs` even when
 * the child cannot be killed. That matters on Windows, where a `.cmd` shim runs
 * under `cmd.exe` and killing `cmd.exe` leaves the `node` grandchild holding
 * the stdio pipes open — `execFile`'s own `timeout` would then never surface a
 * result and discovery would hang forever instead of merely reporting slowly.
 */
export async function readCommandVersion(
  params: ReadCommandVersionOptions,
): Promise<CommandVersionProbeResult> {
  const timeoutMs = normalizeVersionTimeoutMs(params.timeoutMs);
  if (params.signal?.aborted) {
    return cancelledVersionProbe("aborted", timeoutMs);
  }

  const controller = new AbortController();
  let cancellation: "timed_out" | "aborted" | undefined;
  const cancel = (reason: "timed_out" | "aborted"): void => {
    cancellation ??= reason;
    controller.abort();
  };
  const onCallerAbort = (): void => cancel("aborted");
  params.signal?.addEventListener("abort", onCallerAbort, { once: true });
  const timer = setTimeout(() => cancel("timed_out"), timeoutMs);
  const cancelled = new Promise<"cancelled">((resolve) => {
    controller.signal.addEventListener("abort", () => resolve("cancelled"), {
      once: true,
    });
  });

  try {
    const invocation = createCommandInvocation({
      command: params.command,
      args: params.versionArgs ?? ["--version"],
      env: params.env,
      platform: params.platform,
    });
    // Settle-or-fail is folded into the promise so racing it against
    // `cancelled` can never leave an unhandled rejection behind.
    const execution = execFile(invocation.command, invocation.args, {
      env: params.env,
      timeout: timeoutMs,
      signal: controller.signal,
      windowsHide: true,
      windowsVerbatimArguments: invocation.windowsVerbatimArguments,
    }).then(
      (result) => ({ ok: true as const, result }),
      (error: unknown) => ({ ok: false as const, error }),
    );

    const settled = await Promise.race([execution, cancelled]);
    if (settled === "cancelled") {
      return cancelledVersionProbe(cancellation ?? "aborted", timeoutMs);
    }
    if (!settled.ok) {
      return describeFailedVersionProbe(settled.error, cancellation, timeoutMs);
    }

    const output = `${settled.result.stdout}\n${settled.result.stderr ?? ""}`;
    const version = params.parseVersion(output);
    return version
      ? { outcome: "ok", ran: true, version, timeoutMs }
      : {
          outcome: "version_not_reported",
          ran: true,
          failureReason: "version_not_reported",
          timeoutMs,
        };
  } catch (error) {
    // `createCommandInvocation` rejects command lines it cannot quote safely.
    return describeFailedVersionProbe(error, cancellation, timeoutMs);
  } finally {
    clearTimeout(timer);
    params.signal?.removeEventListener("abort", onCallerAbort);
  }
}

function describeFailedVersionProbe(
  error: unknown,
  cancellation: "timed_out" | "aborted" | undefined,
  timeoutMs: number,
): CommandVersionProbeResult {
  // Our own abort caused this rejection — report the reason we aborted for,
  // not the AbortError it surfaced as.
  if (cancellation) {
    return cancelledVersionProbe(cancellation, timeoutMs);
  }
  if (isNotFoundError(error)) {
    return { outcome: "not_found", ran: false, failureReason: "not_found", timeoutMs };
  }
  if (isPermissionError(error)) {
    return {
      outcome: "not_executable",
      ran: false,
      failureReason: "not_executable",
      timeoutMs,
    };
  }
  if (wasKilledByExecFile(error)) {
    return cancelledVersionProbe("timed_out", timeoutMs);
  }
  return {
    outcome: "failed",
    ran: false,
    failureReason: error instanceof Error ? error.message : String(error),
    timeoutMs,
  };
}

export async function buildCommandDiscoveryCandidate<Source extends string>(
  candidate: CommandDiscoveryInput<Source>,
  options: {
    env: NodeJS.ProcessEnv;
    platform?: NodeJS.Platform | undefined;
    versionArgs?: string[] | undefined;
    parseVersion: (output: string) => string | undefined;
    validateVersion?: ((version: string) => string | undefined) | undefined;
    preflightCandidate?: ((params: {
      command: string;
      source: Source;
      env: NodeJS.ProcessEnv;
      platform: NodeJS.Platform;
      signal?: AbortSignal | undefined;
    }) => Promise<CommandDiscoveryPreflightResult | undefined>) | undefined;
    versionTimeoutMs?: number | undefined;
    signal?: AbortSignal | undefined;
  },
): Promise<CommandDiscoveryCandidate<Source> | undefined> {
  const trimmedCommand = candidate.command?.trim();
  if (!trimmedCommand) {
    return undefined;
  }

  const platform = options.platform ?? process.platform;
  const shouldResolveFromPath =
    candidate.source === "path" || !commandHasPathSeparator(trimmedCommand);
  const resolvedCommand = shouldResolveFromPath
    ? await resolvePathCommand(trimmedCommand, options.env, platform)
    : trimmedCommand;
  const probeCommand = resolvedCommand ?? trimmedCommand;
  const existence = resolvedCommand ? await pathExists(resolvedCommand) : "unknown";
  const accessExecutable =
    resolvedCommand && existence !== "not_found"
      ? await pathIsExecutable(resolvedCommand, { env: options.env, platform })
      : false;
  const preflightResult = existence !== "not_found"
    ? await options.preflightCandidate?.({
        command: probeCommand,
        source: candidate.source,
        env: options.env,
        platform,
        signal: options.signal,
      })
    : undefined;

  if (preflightResult?.failureReason) {
    return {
      command: resolvedCommand || trimmedCommand,
      source: candidate.source,
      executable: false,
      selected: false,
      version: preflightResult.version,
      versionFailureReason: preflightResult.versionFailureReason,
      failureReason: preflightResult.failureReason,
    };
  }

  const versionResult: CommandVersionProbeResult = existence !== "not_found"
    ? preflightResult?.skipVersionProbe
      ? {
          // Carry the preflight's own verdict into the outcome. Hardcoding
          // "version_not_reported" here would swallow a preflight that said
          // "not_found", which the failure-reason mapping below keys on.
          outcome: preflightResult.version
            ? "ok"
            : preflightResult.versionFailureReason === "not_found"
              ? "not_found"
              : "version_not_reported",
          ran: accessExecutable,
          version: preflightResult.version,
          failureReason: preflightResult.version
            ? undefined
            : (preflightResult.versionFailureReason ?? "version_not_reported"),
        }
      : await readCommandVersion({
          command: probeCommand,
          env: options.env,
          platform,
          parseVersion: options.parseVersion,
          versionArgs: options.versionArgs ?? ["--version"],
          timeoutMs: options.versionTimeoutMs,
          signal: options.signal,
        })
    : { outcome: "not_found", ran: false, failureReason: "not_found" };
  const version = versionResult.version ?? preflightResult?.version;
  const versionValidationFailure = version
    ? options.validateVersion?.(version)
    : undefined;
  if (versionValidationFailure) {
    return {
      command: resolvedCommand || trimmedCommand,
      source: candidate.source,
      executable: false,
      selected: false,
      version,
      versionFailureReason: undefined,
      failureReason: versionValidationFailure,
      versionProbeOutcome: versionResult.outcome,
    };
  }

  const executable = accessExecutable || versionResult.ran;

  return {
    command: resolvedCommand || trimmedCommand,
    source: candidate.source,
    executable,
    selected: false,
    version,
    versionFailureReason: executable ? versionResult.failureReason : undefined,
    // A probe that overran its budget (or was abandoned) proves nothing about
    // the command — reporting `not_executable` there is the misdiagnosis this
    // whole seam exists to avoid, so keep those cases separately labelled.
    failureReason: executable
      ? undefined
      : existence === "not_found" || versionResult.outcome === "not_found"
        ? "not_found"
        : versionResult.outcome === "timed_out"
          ? "version_probe_timed_out"
          : versionResult.outcome === "aborted"
            ? "version_probe_aborted"
            : "not_executable",
    versionProbeOutcome: versionResult.outcome,
  };
}

export async function discoverCommands<Source extends string>(
  options: DiscoverCommandOptions<Source>,
): Promise<CommandDiscoverySnapshot<Source>> {
  if (options.signal?.aborted) {
    return { candidates: [], error: COMMAND_DISCOVERY_ABORTED };
  }

  // Both groups in ONE parallel wave: awaiting them in sequence would make the
  // worst case two full probe budgets deep, which matters much more now that
  // the budget is 10s rather than 2s.
  const [builtFixed, builtAuto] = await Promise.all([
    Promise.all(
      options.fixedCandidates.map((candidate) =>
        buildCommandDiscoveryCandidate(candidate, options),
      ),
    ),
    Promise.all(
      options.autoCandidates.map((candidate) =>
        buildCommandDiscoveryCandidate(candidate, options),
      ),
    ),
  ]);

  const fixedCandidates = builtFixed.filter(
    (candidate): candidate is CommandDiscoveryCandidate<Source> => Boolean(candidate),
  );

  const autoCandidates = dedupeCommandDiscoveryCandidates(builtAuto);

  const executableAutoCandidates = autoCandidates.filter((candidate) => candidate.executable);
  const includeFailedAutoCandidates =
    options.includeFailedAutoCandidates === "if-none-executable"
      ? executableAutoCandidates.length === 0
      : options.includeFailedAutoCandidates === true;
  const visibleAutoCandidates = autoCandidates
    .filter((candidate) =>
      includeFailedAutoCandidates
      || candidate.executable
      || candidate.version
      // A candidate whose probe ran out of budget (or was abandoned) is the
      // one case a host MUST still see: dropping it here is what makes a slow
      // machine look like a machine with nothing installed. It stays visible
      // as a non-executable candidate carrying `versionProbeOutcome`.
      || isUnprovenVersionProbe(candidate.versionProbeOutcome),
    )
    .sort((left, right) =>
      options.compareVersions
        ? options.compareVersions(right.version, left.version)
        : 0,
    );

  const candidates = [...fixedCandidates, ...visibleAutoCandidates];
  const selected =
    fixedCandidates.find((candidate) => candidate.source === "env" && candidate.executable)
    ?? fixedCandidates.find((candidate) => candidate.source === "config" && candidate.executable)
    ?? visibleAutoCandidates.find((candidate) => candidate.executable);

  if (selected) {
    selected.selected = true;
  }

  // Report abandonment from the EVIDENCE, not from a trailing read of the
  // signal: a signal that fires after every probe finished leaves a complete
  // snapshot, and labelling that one aborted makes callers discard good
  // results (and, in `resolveCodexCommand`, mask a `codex_too_old` verdict).
  const abandoned = candidates.some(
    (candidate) => candidate.versionProbeOutcome === "aborted",
  );

  return {
    selectedCommand: selected?.command,
    selectedSource: selected?.source,
    candidates,
    // Partial results still ship — an aborted run reports WHY it is thin
    // instead of looking like a machine with nothing installed.
    ...(abandoned ? { error: COMMAND_DISCOVERY_ABORTED } : {}),
  };
}

function dedupeCommandDiscoveryCandidates<Source extends string>(
  candidates: Array<CommandDiscoveryCandidate<Source> | undefined>,
): Array<CommandDiscoveryCandidate<Source>> {
  const deduped: Array<CommandDiscoveryCandidate<Source>> = [];
  const indexByCommand = new Map<string, number>();

  for (const candidate of candidates) {
    if (!candidate) continue;

    const key = candidate.command;
    const existingIndex = indexByCommand.get(key);
    if (existingIndex === undefined) {
      indexByCommand.set(key, deduped.length);
      deduped.push(candidate);
      continue;
    }

    const existing = deduped[existingIndex];
    if (existing === undefined) continue;
    deduped[existingIndex] = mergeCommandDiscoveryCandidates(existing, candidate);
  }

  return deduped;
}

function mergeCommandDiscoveryCandidates<Source extends string>(
  existing: CommandDiscoveryCandidate<Source>,
  candidate: CommandDiscoveryCandidate<Source>,
): CommandDiscoveryCandidate<Source> {
  const preferred = choosePreferredCommandDiscoveryCandidate(existing, candidate);
  const fallback = preferred === existing ? candidate : existing;
  const executable = existing.executable || candidate.executable;

  return {
    command: preferred.command,
    source: preferred.source,
    executable,
    selected: existing.selected || candidate.selected,
    version: preferred.version ?? fallback.version,
    versionFailureReason:
      preferred.versionFailureReason ?? fallback.versionFailureReason,
    failureReason: executable
      ? undefined
      : (preferred.failureReason ?? fallback.failureReason),
    versionProbeOutcome:
      preferred.versionProbeOutcome ?? fallback.versionProbeOutcome,
  };
}

function choosePreferredCommandDiscoveryCandidate<Source extends string>(
  left: CommandDiscoveryCandidate<Source>,
  right: CommandDiscoveryCandidate<Source>,
): CommandDiscoveryCandidate<Source> {
  if (right.executable !== left.executable) {
    return right.executable ? right : left;
  }
  if (right.version && !left.version) {
    return right;
  }
  if (left.version && !right.version) {
    return left;
  }
  if (left.source === "path" && right.source !== "path") {
    return right;
  }
  return left;
}

export async function resolveDiscoveredCommand<Source extends string>(params: {
  command: string;
  fallbackSource: Source;
  discover: (configuredCommand?: string) => Promise<CommandDiscoverySnapshot<Source>>;
}): Promise<ResolvedCommandCandidate<Source>> {
  const configuredCommand =
    params.command.trim() && params.command.trim() !== path.basename(params.command.trim())
      ? params.command.trim()
      : params.command.trim() || undefined;
  const discovery = await params.discover(configuredCommand);
  const selected = discovery.candidates.find((candidate) => candidate.selected);

  if (selected) {
    return {
      command: selected.command,
      source: selected.source,
      version: selected.version,
      versionProbeOutcome: selected.versionProbeOutcome,
    };
  }

  // Nothing was selected. Say WHY when a probe simply ran out of budget —
  // otherwise this bare fallback is indistinguishable from "searched
  // everywhere, found nothing", which is the wrong story to tell a user.
  //
  // Only THIS command's own outcome qualifies: pinning some other candidate's
  // timeout onto the returned name would send a caller off to re-probe a
  // command that never timed out, which fails the same way forever.
  const fallbackCommand = params.command.trim() || path.basename(params.command);
  const unproven = discovery.candidates.find(
    (candidate) =>
      candidate.command === fallbackCommand
      && isUnprovenVersionProbe(candidate.versionProbeOutcome),
  );
  return {
    command: fallbackCommand,
    source: params.fallbackSource,
    versionProbeOutcome: unproven?.versionProbeOutcome,
  };
}
