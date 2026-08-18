import { describe, it, expect } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  discoverCodexCommands,
  resolveCodexCommand,
  compareCodexCliVersions,
  getCodexInstallCandidatePaths,
  CodexCliNotInstalledError,
  CODEX_COMMAND_ENV,
  MINIMUM_CODEX_CLI_VERSION,
} from "../src/index";
import { makeTempDir, writeFakeCodex } from "./helpers";

const isWindows = process.platform === "win32";

// Discovery probes hardcoded install locations (`/usr/local/bin/codex` and
// friends) on top of PATH. A real Codex CLI on the machine running the tests
// would be discovered, outrank the fixture shims, and make the
// "nothing installed" cases resolve instead of throwing. So every test that
// cares about *which* command is selected scopes the auto-candidates to its
// own temp dirs, or to nothing at all via this constant. The two tests that
// deliberately exercise the default list assert only on things a real install
// cannot change.
const NO_INSTALL_CANDIDATES: readonly string[] = [];

describe("compareCodexCliVersions", () => {
  it("orders releases by major.minor.patch", () => {
    expect(compareCodexCliVersions("0.130.0", "0.125.0")).toBeGreaterThan(0);
    expect(compareCodexCliVersions("0.125.0", "0.130.0")).toBeLessThan(0);
    expect(compareCodexCliVersions("1.0.0", "0.999.999")).toBeGreaterThan(0);
    expect(compareCodexCliVersions("0.130.0", "0.130.0")).toBe(0);
  });

  it("ranks a release above its prerelease", () => {
    expect(compareCodexCliVersions("0.130.0", "0.130.0-rc.1")).toBeGreaterThan(0);
    expect(compareCodexCliVersions("0.130.0-rc.1", "0.130.0")).toBeLessThan(0);
  });

  it("orders prereleases numerically and lexically per semver", () => {
    expect(compareCodexCliVersions("0.130.0-rc.2", "0.130.0-rc.1")).toBeGreaterThan(0);
    expect(compareCodexCliVersions("0.130.0-alpha", "0.130.0-beta")).toBeLessThan(0);
    // numeric identifiers always have lower precedence than alphanumeric
    expect(compareCodexCliVersions("0.130.0-1", "0.130.0-alpha")).toBeLessThan(0);
  });

  it("treats an unparseable version as lowest", () => {
    expect(compareCodexCliVersions(undefined, "0.130.0")).toBeLessThan(0);
    expect(compareCodexCliVersions("0.130.0", undefined)).toBeGreaterThan(0);
    expect(compareCodexCliVersions(undefined, undefined)).toBe(0);
  });
});

describe.skipIf(isWindows)("discoverCodexCommands", () => {
  it("includes macOS app bundle and Homebrew install candidates", () => {
    expect(getCodexInstallCandidatePaths("darwin", "/Users/alice")).toEqual([
      "/Applications/ChatGPT.app/Contents/Resources/codex",
      "/Applications/Codex.app/Contents/Resources/codex",
      "/Users/alice/Applications/ChatGPT.app/Contents/Resources/codex",
      "/Users/alice/Applications/Codex.app/Contents/Resources/codex",
      "/opt/homebrew/bin/codex",
      "/usr/local/bin/codex",
    ]);
  });

  it("defaults the auto candidates to the platform install list", async () => {
    // No `installCandidatePaths` — the default list is what gets probed, so a
    // path that is not on it can never be discovered.
    const dir = makeTempDir();
    try {
      const cmd = writeFakeCodex({ dir, version: "0.140.0" });
      expect(getCodexInstallCandidatePaths("linux")).not.toContain(cmd);

      const snapshot = await discoverCodexCommands({
        env: { PATH: "/nonexistent" },
        platform: "linux",
      });
      expect(snapshot.candidates.map((c) => c.command)).not.toContain(cmd);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("probes an explicit installCandidatePaths list instead of the platform default", async () => {
    const dir = makeTempDir();
    try {
      const cmd = writeFakeCodex({ dir, version: "0.140.0" });
      const snapshot = await discoverCodexCommands({
        env: { PATH: "/nonexistent" },
        platform: "linux",
        installCandidatePaths: [cmd],
      });
      expect(snapshot.selectedCommand).toBe(cmd);
      expect(snapshot.selectedSource).toBe("application");
      expect(snapshot.candidates.find((c) => c.selected)?.version).toBe(
        "0.140.0",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("expands the default user-local candidates against a supplied homeDir", async () => {
    const home = makeTempDir();
    try {
      const binDir = path.join(home, ".local/bin");
      mkdirSync(binDir, { recursive: true });
      const cmd = writeFakeCodex({ dir: binDir, version: "0.141.0" });
      expect(getCodexInstallCandidatePaths("linux", home)).toContain(cmd);

      const snapshot = await discoverCodexCommands({
        env: { PATH: "/nonexistent" },
        platform: "linux",
        homeDir: home,
      });
      // Asserted by presence rather than selection: the default list also
      // covers system paths, where a real Codex install may out-rank the shim.
      const candidate = snapshot.candidates.find((c) => c.command === cmd);
      expect(candidate?.source).toBe("application");
      expect(candidate?.version).toBe("0.141.0");
      expect(candidate?.executable).toBe(true);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("returns auto candidates newest-first and honors env > config > auto priority", async () => {
    const envDir = makeTempDir();
    const configDir = makeTempDir();
    const appDirA = makeTempDir();
    const appDirB = makeTempDir();
    try {
      const envCmd = writeFakeCodex({ dir: envDir, version: "0.140.0" });
      const configCmd = writeFakeCodex({ dir: configDir, version: "0.135.0" });
      // Two "application" candidates with different versions.
      const newerApp = writeFakeCodex({ dir: appDirA, version: "0.130.0" });
      const olderApp = writeFakeCodex({ dir: appDirB, version: "0.126.0" });

      const snapshot = await discoverCodexCommands({
        configuredCommand: configCmd,
        env: { [CODEX_COMMAND_ENV]: envCmd, PATH: "/nonexistent" },
        platform: "linux",
        // Deliberately listed oldest-first to prove discovery sorts them.
        installCandidatePaths: [olderApp, newerApp],
      });

      // env wins selection.
      expect(snapshot.selectedSource).toBe("env");
      expect(snapshot.selectedCommand).toBe(envCmd);
      const env = snapshot.candidates.find((c) => c.source === "env");
      const config = snapshot.candidates.find((c) => c.source === "config");
      expect(env?.selected).toBe(true);
      expect(config?.selected).toBe(false);
      expect(env?.version).toBe("0.140.0");

      // Auto candidates come back newest-first, regardless of input order.
      const appCandidates = snapshot.candidates.filter(
        (c) => c.source === "application",
      );
      expect(appCandidates.map((c) => c.command)).toEqual([newerApp, olderApp]);
      expect(appCandidates.map((c) => c.version)).toEqual([
        "0.130.0",
        "0.126.0",
      ]);
      // Sanity: neither auto candidate outranks the env override.
      expect(appCandidates.some((c) => c.selected)).toBe(false);
    } finally {
      for (const d of [envDir, configDir, appDirA, appDirB]) {
        rmSync(d, { recursive: true, force: true });
      }
    }
  });

  it("falls back to config when env is absent, then to auto", async () => {
    const configDir = makeTempDir();
    try {
      const configCmd = writeFakeCodex({ dir: configDir, version: "0.135.0" });
      const snapshot = await discoverCodexCommands({
        configuredCommand: configCmd,
        env: { PATH: "/nonexistent" },
        platform: "linux",
        installCandidatePaths: NO_INSTALL_CANDIDATES,
      });
      expect(snapshot.selectedSource).toBe("config");
      expect(snapshot.selectedCommand).toBe(configCmd);
    } finally {
      rmSync(configDir, { recursive: true, force: true });
    }
  });

  it("parses and exposes a selected 0.139.0 version with trailing punctuation", async () => {
    const dir = makeTempDir();
    try {
      const cmd = writeFakeCodex({ dir, version: "0.139.0." });
      const snapshot = await discoverCodexCommands({
        env: { PATH: dir },
        platform: "linux",
        installCandidatePaths: NO_INSTALL_CANDIDATES,
      });

      const selectedCandidate = snapshot.candidates.find(
        (candidate) => candidate.selected,
      );
      expect(snapshot.selectedCommand).toBe(cmd);
      expect(snapshot.selectedSource).toBe("path");
      expect(selectedCandidate?.version).toBe("0.139.0");

      const resolved = await resolveCodexCommand({
        command: "codex",
        env: { PATH: dir },
        platform: "linux",
        installCandidatePaths: NO_INSTALL_CANDIDATES,
      });
      expect(resolved).toMatchObject({
        command: cmd,
        source: "path",
        version: "0.139.0",
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("surfaces a too-old binary as a candidate with failureReason codex_too_old (not dropped)", async () => {
    const dir = makeTempDir();
    try {
      // 0.100.0 is below the 0.125.0 minimum.
      const tooOld = writeFakeCodex({ dir, version: "0.100.0" });
      const snapshot = await discoverCodexCommands({
        configuredCommand: tooOld,
        env: { PATH: "/nonexistent" },
        platform: "linux",
        installCandidatePaths: NO_INSTALL_CANDIDATES,
      });
      const candidate = snapshot.candidates.find((c) => c.command === tooOld);
      expect(candidate).toBeDefined();
      expect(candidate?.failureReason).toBe("codex_too_old");
      expect(candidate?.executable).toBe(false);
      expect(candidate?.version).toBe("0.100.0");
      // Nothing usable selected.
      expect(snapshot.selectedCommand).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe.skipIf(isWindows)("resolveCodexCommand", () => {
  it("resolves the selected command from a configured path", async () => {
    const dir = makeTempDir();
    try {
      const cmd = writeFakeCodex({ dir, version: "0.130.0" });
      const resolved = await resolveCodexCommand({
        command: cmd,
        env: { PATH: "/nonexistent" },
        platform: "linux",
        installCandidatePaths: NO_INSTALL_CANDIDATES,
      });
      expect(resolved.command).toBe(cmd);
      expect(resolved.version).toBe("0.130.0");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("throws CodexCliNotInstalledError (not a raw ENOENT) when nothing is found", async () => {
    const emptyDir = makeTempDir();
    try {
      await expect(
        resolveCodexCommand({
          command: "codex",
          // PATH points at an empty dir and no install locations are probed,
          // so discovery genuinely finds nothing.
          env: { PATH: emptyDir },
          platform: "linux",
          installCandidatePaths: NO_INSTALL_CANDIDATES,
        }),
      ).rejects.toBeInstanceOf(CodexCliNotInstalledError);
    } finally {
      rmSync(emptyDir, { recursive: true, force: true });
    }
  });

  it("throws a too-old error (not CodexCliNotInstalledError) when only an old binary exists", async () => {
    const dir = makeTempDir();
    try {
      const tooOld = writeFakeCodex({ dir, version: "0.100.0" });
      await expect(
        resolveCodexCommand({
          command: tooOld,
          env: { PATH: "/nonexistent" },
          platform: "linux",
          installCandidatePaths: NO_INSTALL_CANDIDATES,
        }),
      ).rejects.toThrow(new RegExp(MINIMUM_CODEX_CLI_VERSION));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not leave a stray basename when the configured command exists", async () => {
    const dir = makeTempDir();
    try {
      const cmd = writeFakeCodex({ dir, version: "0.130.0" });
      const resolved = await resolveCodexCommand({
        command: cmd,
        env: { PATH: "/nonexistent" },
        platform: "linux",
        installCandidatePaths: NO_INSTALL_CANDIDATES,
      });
      expect(path.basename(resolved.command)).toBe("codex");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe.runIf(isWindows)("resolveCodexCommand (.cmd shim)", () => {
  it("resolves and probes a configured npm-style codex.cmd through the real launch path", async () => {
    const rootDir = makeTempDir("codex-discovery-win-");
    const shimDir = path.join(rootDir, "NVM & npm");
    try {
      mkdirSync(shimDir, { recursive: true });
      const codexScript = path.join(shimDir, "codex.js");
      const codexShim = path.join(shimDir, "codex.cmd");
      writeFileSync(
        codexScript,
        `if (process.argv[2] === "--version") console.log("codex-cli 0.140.0");\n`,
        "utf8",
      );
      writeFileSync(
        codexShim,
        `@ECHO off\nSETLOCAL\nnode "%~dp0\\codex.js" %*\n`,
        "utf8",
      );

      const env = { ...process.env };
      for (const key of Object.keys(env)) {
        if (key.toLowerCase() === "path") delete env[key];
      }
      env.Path = `${shimDir};${path.dirname(process.execPath)}`;
      env.PATHEXT = ".COM;.EXE;.BAT;.CMD";

      const resolved = await resolveCodexCommand({
        command: codexShim,
        env,
        platform: "win32",
        installCandidatePaths: NO_INSTALL_CANDIDATES,
      });

      expect(resolved).toEqual({
        command: codexShim,
        source: "config",
        version: "0.140.0",
        // The shim answered, so the version is measured rather than assumed.
        versionProbeOutcome: "ok",
      });
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  });
});
