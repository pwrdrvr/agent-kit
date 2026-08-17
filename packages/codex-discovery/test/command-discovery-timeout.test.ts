// A version probe that overruns its budget must be reported as "did not answer
// in time" — never as "not installed" / "not executable". These tests pin the
// distinction end to end: the probe result, the discovery candidate, and the
// resolved-command shape a host reads.

import { describe, it, expect } from "vitest";
import { chmodSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  COMMAND_DISCOVERY_ABORTED,
  CodexCliNotInstalledError,
  CodexDiscoveryAbortedError,
  DEFAULT_COMMAND_VERSION_TIMEOUT_MS,
  discoverCommands,
  isUnprovenVersionProbe,
  readCommandVersion,
  resolveCodexCommand,
  resolveDiscoveredCommand,
} from "../src/index";
import { makeTempDir } from "./helpers";

const isWindows = process.platform === "win32";

function parseSimpleVersion(output: string): string | undefined {
  return output.match(/(\d+\.\d+\.\d+)/)?.[1];
}

/**
 * A shim that cannot answer `--version` inside a small budget.
 *
 * Deliberately NOT `#!/bin/sh` + `sleep`: these probes run with an env whose
 * `PATH` is just the temp dir, so the shell cannot resolve `sleep`, prints
 * "command not found", and races on to `echo` — answering instantly. Running
 * the delay inside `process.execPath` needs no `PATH` lookup at all, and dies
 * cleanly on kill instead of orphaning a `sleep`.
 */
function writeSlowShim(dir: string, name = "slowtool"): string {
  const shim = path.join(dir, name);
  writeFileSync(
    shim,
    `#!${process.execPath}\nsetTimeout(() => { console.log("${name} 9.9.9"); }, 3000);\n`,
    "utf8",
  );
  chmodSync(shim, 0o755);
  return shim;
}

function writeFastShim(dir: string, name = "fasttool"): string {
  const shim = path.join(dir, name);
  writeFileSync(shim, `#!/bin/sh\necho "${name} 1.2.3"\n`, "utf8");
  chmodSync(shim, 0o755);
  return shim;
}

describe("DEFAULT_COMMAND_VERSION_TIMEOUT_MS", () => {
  it("leaves headroom for a cmd.exe -> node -> shim chain, not just a native binary", () => {
    // A warm npm `codex.cmd` measures ~1.5s and a native binary ~0.3s; the old
    // hardcoded 2s sat on top of the shim number, so a loaded machine crossed
    // it and the CLI was reported missing.
    expect(DEFAULT_COMMAND_VERSION_TIMEOUT_MS).toBe(10_000);
  });
});

describe.skipIf(isWindows)("readCommandVersion — outcomes", () => {
  it("reports timed_out (not not_found) and settles within its budget", async () => {
    const dir = makeTempDir();
    try {
      const shim = writeSlowShim(dir);
      const startedAt = Date.now();
      const result = await readCommandVersion({
        command: shim,
        env: { PATH: dir },
        platform: "linux",
        parseVersion: parseSimpleVersion,
        timeoutMs: 150,
      });

      expect(result.outcome).toBe("timed_out");
      expect(result.ran).toBe(false);
      expect(result.version).toBeUndefined();
      expect(result.failureReason).toBe("version_probe_timed_out");
      expect(result.timeoutMs).toBe(150);
      expect(isUnprovenVersionProbe(result.outcome)).toBe(true);
      // The budget is authoritative: the probe returns even though the shim is
      // still sleeping for seconds.
      expect(Date.now() - startedAt).toBeLessThan(3_000);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reports ok with the parsed version when the command answers", async () => {
    const dir = makeTempDir();
    try {
      const shim = writeFastShim(dir);
      const result = await readCommandVersion({
        command: shim,
        env: { PATH: dir },
        platform: "linux",
        parseVersion: parseSimpleVersion,
      });
      expect(result).toMatchObject({ outcome: "ok", ran: true, version: "1.2.3" });
      expect(isUnprovenVersionProbe(result.outcome)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reports not_found for a missing command", async () => {
    const dir = makeTempDir();
    try {
      const result = await readCommandVersion({
        command: path.join(dir, "ghost"),
        env: { PATH: dir },
        platform: "linux",
        parseVersion: parseSimpleVersion,
      });
      expect(result.outcome).toBe("not_found");
      expect(result.failureReason).toBe("not_found");
      expect(isUnprovenVersionProbe(result.outcome)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reports not_executable for a file without the execute bit", async () => {
    const dir = makeTempDir();
    try {
      const data = path.join(dir, "data");
      writeFileSync(data, "not a program", "utf8");
      chmodSync(data, 0o644);
      const result = await readCommandVersion({
        command: data,
        env: { PATH: dir },
        platform: "linux",
        parseVersion: parseSimpleVersion,
      });
      expect(result.outcome).toBe("not_executable");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reports version_not_reported when the command runs but prints no version", async () => {
    const dir = makeTempDir();
    try {
      const shim = path.join(dir, "quiet");
      writeFileSync(shim, "#!/bin/sh\necho hello\n", "utf8");
      chmodSync(shim, 0o755);
      const result = await readCommandVersion({
        command: shim,
        env: { PATH: dir },
        platform: "linux",
        parseVersion: parseSimpleVersion,
      });
      expect(result).toMatchObject({ outcome: "version_not_reported", ran: true });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reports aborted without spawning when the signal is already aborted", async () => {
    const result = await readCommandVersion({
      command: "anything",
      env: {},
      platform: "linux",
      parseVersion: parseSimpleVersion,
      signal: AbortSignal.abort(),
    });
    expect(result.outcome).toBe("aborted");
    expect(result.failureReason).toBe("version_probe_aborted");
    expect(isUnprovenVersionProbe(result.outcome)).toBe(true);
  });

  it("reports aborted (not timed_out) when the caller cancels an in-flight probe", async () => {
    const dir = makeTempDir();
    try {
      const shim = writeSlowShim(dir);
      const controller = new AbortController();
      const pending = readCommandVersion({
        command: shim,
        env: { PATH: dir },
        platform: "linux",
        parseVersion: parseSimpleVersion,
        timeoutMs: 5_000,
        signal: controller.signal,
      });
      setTimeout(() => controller.abort(), 50);
      const result = await pending;
      expect(result.outcome).toBe("aborted");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe.skipIf(isWindows)("discoverCommands — timeout is not 'not installed'", () => {
  it("labels a slow candidate timed_out and keeps it selectable", async () => {
    const dir = makeTempDir();
    try {
      const shim = writeSlowShim(dir);
      const snapshot = await discoverCommands<"path">({
        env: { PATH: dir },
        platform: "linux",
        fixedCandidates: [],
        autoCandidates: [{ command: "slowtool", source: "path" }],
        parseVersion: parseSimpleVersion,
        versionTimeoutMs: 150,
      });

      const candidate = snapshot.candidates.find((entry) => entry.command === shim);
      expect(candidate).toBeDefined();
      expect(candidate?.versionProbeOutcome).toBe("timed_out");
      expect(candidate?.version).toBeUndefined();
      expect(candidate?.versionFailureReason).toBe("version_probe_timed_out");
      // The file is on disk and executable, so this stays a usable candidate —
      // only its VERSION is unknown.
      expect(candidate?.executable).toBe(true);
      expect(candidate?.failureReason).toBeUndefined();
      expect(snapshot.selectedCommand).toBe(shim);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps a timed-out candidate visible even when it never proved executable", async () => {
    const dir = makeTempDir();
    try {
      // `platform: "win32"` makes PATH resolution build backslash paths that
      // miss on a POSIX host, so the candidate is never proven executable —
      // while the real spawn still finds the shim via PATH and overruns. That
      // is the shape a host must not read as "nothing installed".
      writeSlowShim(dir);
      const snapshot = await discoverCommands<"path">({
        env: { PATH: dir },
        platform: "win32",
        fixedCandidates: [],
        autoCandidates: [{ command: "slowtool", source: "path" }],
        parseVersion: parseSimpleVersion,
        versionTimeoutMs: 150,
      });

      const candidate = snapshot.candidates.find((entry) => entry.command === "slowtool");
      expect(candidate).toBeDefined();
      expect(candidate?.executable).toBe(false);
      expect(candidate?.versionProbeOutcome).toBe("timed_out");
      // The old code said "not_executable" here, which reads as a broken or
      // absent install rather than an unfinished measurement.
      expect(candidate?.failureReason).toBe("version_probe_timed_out");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("still reports not_found for a command that genuinely is not there", async () => {
    const dir = makeTempDir();
    try {
      const snapshot = await discoverCommands<"config">({
        env: { PATH: dir },
        platform: "linux",
        fixedCandidates: [{ command: path.join(dir, "ghost"), source: "config" }],
        autoCandidates: [],
        parseVersion: parseSimpleVersion,
      });
      const candidate = snapshot.candidates[0];
      expect(candidate?.failureReason).toBe("not_found");
      expect(candidate?.versionProbeOutcome).toBe("not_found");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe.skipIf(isWindows)("discoverCommands — cancellation", () => {
  it("returns an aborted snapshot instead of probing when pre-aborted", async () => {
    const dir = makeTempDir();
    try {
      writeSlowShim(dir);
      const snapshot = await discoverCommands<"path">({
        env: { PATH: dir },
        platform: "linux",
        fixedCandidates: [],
        autoCandidates: [{ command: "slowtool", source: "path" }],
        parseVersion: parseSimpleVersion,
        signal: AbortSignal.abort(),
      });
      expect(snapshot.candidates).toEqual([]);
      expect(snapshot.error).toBe(COMMAND_DISCOVERY_ABORTED);
      expect(snapshot.selectedCommand).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("abandons in-flight probes and flags the snapshot", async () => {
    const dir = makeTempDir();
    try {
      writeSlowShim(dir);
      const controller = new AbortController();
      const startedAt = Date.now();
      const pending = discoverCommands<"path">({
        env: { PATH: dir },
        platform: "linux",
        fixedCandidates: [],
        autoCandidates: [{ command: "slowtool", source: "path" }],
        parseVersion: parseSimpleVersion,
        versionTimeoutMs: 30_000,
        signal: controller.signal,
      });
      setTimeout(() => controller.abort(), 50);
      const snapshot = await pending;

      expect(Date.now() - startedAt).toBeLessThan(3_000);
      expect(snapshot.error).toBe(COMMAND_DISCOVERY_ABORTED);
      expect(
        snapshot.candidates.some(
          (candidate) => candidate.versionProbeOutcome === "aborted",
        ),
      ).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe.skipIf(isWindows)("resolveCodexCommand — timeout vs. not installed", () => {
  it("resolves the command but marks the version unknown when the probe overruns", async () => {
    const dir = makeTempDir();
    try {
      const shim = writeSlowShim(dir, "codex-slow");
      const resolved = await resolveCodexCommand({
        command: shim,
        env: { PATH: dir },
        platform: "linux",
        versionTimeoutMs: 150,
      });
      expect(resolved.command).toBe(shim);
      expect(resolved.version).toBeUndefined();
      // Without this a version-gating host sees "no version" and demotes a
      // perfectly good install to "not installed".
      expect(resolved.versionProbeOutcome).toBe("timed_out");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("says the probe timed out rather than plain 'not installed'", async () => {
    const dir = makeTempDir();
    try {
      // win32 resolution on a POSIX host: nothing is ever proven executable,
      // so nothing is selected — but the probe still overran.
      writeSlowShim(dir);
      const failure = await resolveCodexCommand({
        command: "slowtool",
        env: { PATH: dir },
        platform: "win32",
        versionTimeoutMs: 150,
      }).catch((error: unknown) => error);

      expect(failure).toBeInstanceOf(CodexCliNotInstalledError);
      const error = failure as CodexCliNotInstalledError;
      expect(error.probeTimedOut).toBe(true);
      expect(error.timedOutCommands).toContain("slowtool");
      expect(error.message).toMatch(/did not answer --version in time/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reports a plain not-installed error when nothing timed out", async () => {
    const dir = makeTempDir();
    try {
      const failure = await resolveCodexCommand({
        command: path.join(dir, "ghost"),
        env: { PATH: dir },
        platform: "win32",
      }).catch((error: unknown) => error);

      expect(failure).toBeInstanceOf(CodexCliNotInstalledError);
      expect((failure as CodexCliNotInstalledError).probeTimedOut).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("throws an abort error (never 'not installed') when discovery is cancelled", async () => {
    const dir = makeTempDir();
    try {
      const failure = await resolveCodexCommand({
        command: path.join(dir, "ghost"),
        env: { PATH: dir },
        platform: "linux",
        signal: AbortSignal.abort(),
      }).catch((error: unknown) => error);

      expect(failure).toBeInstanceOf(CodexDiscoveryAbortedError);
      expect(failure).not.toBeInstanceOf(CodexCliNotInstalledError);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe.skipIf(isWindows)("resolveDiscoveredCommand — carries the probe outcome", () => {
  it("hands back timed_out alongside the resolved command", async () => {
    const dir = makeTempDir();
    try {
      const shim = writeSlowShim(dir);
      const resolved = await resolveDiscoveredCommand<"path">({
        command: shim,
        fallbackSource: "path",
        discover: () =>
          discoverCommands<"path">({
            env: { PATH: dir },
            platform: "linux",
            fixedCandidates: [],
            autoCandidates: [{ command: shim, source: "path" }],
            parseVersion: parseSimpleVersion,
            versionTimeoutMs: 150,
          }),
      });
      expect(resolved.command).toBe(shim);
      expect(resolved.version).toBeUndefined();
      expect(resolved.versionProbeOutcome).toBe("timed_out");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("explains a bare-name fallback caused by a timeout", async () => {
    const dir = makeTempDir();
    try {
      writeSlowShim(dir);
      const resolved = await resolveDiscoveredCommand<"path">({
        command: "slowtool",
        fallbackSource: "path",
        discover: () =>
          discoverCommands<"path">({
            // win32 resolution misses on POSIX, so nothing is selected — but
            // the reason is a timeout, not an empty machine.
            env: { PATH: dir },
            platform: "win32",
            fixedCandidates: [],
            autoCandidates: [{ command: "slowtool", source: "path" }],
            parseVersion: parseSimpleVersion,
            versionTimeoutMs: 150,
          }),
      });
      expect(resolved.command).toBe("slowtool");
      expect(resolved.versionProbeOutcome).toBe("timed_out");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
