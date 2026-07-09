import { describe, it, expect } from "vitest";
import { rmSync } from "node:fs";
import path from "node:path";
import {
  discoverCodexCommands,
  resolveCodexCommand,
  compareCodexCliVersions,
  CodexCliNotInstalledError,
  CODEX_COMMAND_ENV,
  MINIMUM_CODEX_CLI_VERSION,
} from "../src/index";
import { getCodexInstallCandidatePaths } from "../src/codex-discovery";
import { makeTempDir, writeFakeCodex } from "./helpers";

const isWindows = process.platform === "win32";

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

  it("returns auto candidates newest-first and honors env > config > auto priority", async () => {
    const envDir = makeTempDir();
    const configDir = makeTempDir();
    const appDirA = makeTempDir();
    const appDirB = makeTempDir();
    try {
      const envCmd = writeFakeCodex({ dir: envDir, version: "0.140.0" });
      const configCmd = writeFakeCodex({ dir: configDir, version: "0.135.0" });
      // Two "application" candidates with different versions.
      writeFakeCodex({ dir: appDirA, version: "0.130.0" });
      const olderApp = writeFakeCodex({ dir: appDirB, version: "0.126.0" });

      const snapshot = await discoverCodexCommands({
        configuredCommand: configCmd,
        env: { [CODEX_COMMAND_ENV]: envCmd, PATH: "/nonexistent" },
        platform: "linux",
      });

      // env wins selection.
      expect(snapshot.selectedSource).toBe("env");
      expect(snapshot.selectedCommand).toBe(envCmd);
      const env = snapshot.candidates.find((c) => c.source === "env");
      const config = snapshot.candidates.find((c) => c.source === "config");
      expect(env?.selected).toBe(true);
      expect(config?.selected).toBe(false);
      expect(env?.version).toBe("0.140.0");

      // Sanity: olderApp is present and not selected.
      const olderAppCandidate = snapshot.candidates.find(
        (c) => c.command === olderApp,
      );
      // It is an "application" path candidate; may be merged but should be visible.
      expect(olderAppCandidate?.selected ?? false).toBe(false);
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
          // PATH points at an empty dir; no auto install paths exist on a fresh tmp.
          env: { PATH: emptyDir },
          platform: "linux",
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
      });
      expect(path.basename(resolved.command)).toBe("codex");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
