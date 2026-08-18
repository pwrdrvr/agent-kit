import { describe, it, expect } from "vitest";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  discoverCommands,
  resolveDiscoveredCommand,
  pathIsExecutable,
} from "../src/index";
// Not part of the package's public surface — imported directly so the win32
// name ORDER can be asserted on any host. The end-to-end resolution below
// needs a real win32 filesystem; the ordering rule does not.
import { buildPathCommandNames } from "../src/command-discovery";
import { makeTempDir } from "./helpers";

const isWindows = process.platform === "win32";

function parseSimpleVersion(output: string): string | undefined {
  return output.match(/(\d+\.\d+\.\d+)/)?.[1];
}

describe.skipIf(isWindows)("discoverCommands (PATH resolution)", () => {
  it("resolves a bare command name against PATH and reports it executable", async () => {
    const binDir = makeTempDir();
    try {
      const tool = path.join(binDir, "mytool");
      writeFileSync(tool, `#!/bin/sh\necho "mytool 1.2.3"\n`, "utf8");
      chmodSync(tool, 0o755);

      const snapshot = await discoverCommands<"path">({
        env: { PATH: binDir },
        platform: "linux",
        fixedCandidates: [],
        autoCandidates: [{ command: "mytool", source: "path" }],
        parseVersion: parseSimpleVersion,
      });

      const candidate = snapshot.candidates.find((c) => c.source === "path");
      expect(candidate?.command).toBe(tool);
      expect(candidate?.executable).toBe(true);
      expect(candidate?.version).toBe("1.2.3");
      expect(snapshot.selectedCommand).toBe(tool);
    } finally {
      rmSync(binDir, { recursive: true, force: true });
    }
  });

  it("strips surrounding quotes from a PATH entry before resolving", async () => {
    const binDir = makeTempDir();
    try {
      const tool = path.join(binDir, "quoted");
      writeFileSync(tool, `#!/bin/sh\necho "quoted 9.9.9"\n`, "utf8");
      chmodSync(tool, 0o755);

      const snapshot = await discoverCommands<"path">({
        env: { PATH: `"${binDir}"` },
        platform: "linux",
        fixedCandidates: [],
        autoCandidates: [{ command: "quoted", source: "path" }],
        parseVersion: parseSimpleVersion,
      });
      expect(snapshot.candidates.find((c) => c.source === "path")?.command).toBe(tool);
    } finally {
      rmSync(binDir, { recursive: true, force: true });
    }
  });

  it("dedupes auto candidates that resolve to the same path", async () => {
    const binDir = makeTempDir();
    try {
      const tool = path.join(binDir, "dupe");
      writeFileSync(tool, `#!/bin/sh\necho "dupe 1.0.0"\n`, "utf8");
      chmodSync(tool, 0o755);

      const snapshot = await discoverCommands<"path" | "application">({
        env: { PATH: binDir },
        platform: "linux",
        fixedCandidates: [],
        autoCandidates: [
          { command: "dupe", source: "path" },
          { command: tool, source: "application" },
        ],
        parseVersion: parseSimpleVersion,
      });
      const matches = snapshot.candidates.filter((c) => c.command === tool);
      expect(matches).toHaveLength(1);
    } finally {
      rmSync(binDir, { recursive: true, force: true });
    }
  });
});

// Windows PATHEXT expansion relies on win32 path joining + real-fs existence,
// which only lines up on a Windows host (`path.win32.join` produces
// backslash paths that don't match a POSIX temp file). On non-Windows hosts we
// assert the host-independent slice of the behavior — that the win32 branch is
// taken and a candidate is produced — and run the full resolution assertion
// only on win32.
// npm installs three shims side by side: `codex` (an sh script for Git Bash),
// `codex.cmd`, and `codex.ps1`. On Windows the extensionless one is not
// startable, so it must never win the scan — the whole "Codex is installed but
// discovery says it is missing" bug is this ordering.
describe("buildPathCommandNames (win32 name order)", () => {
  const PATHEXT = ".COM;.EXE;.BAT;.CMD";

  it("never offers the bare extensionless name on win32", () => {
    const names = buildPathCommandNames("codex", { PATHEXT }, "win32");
    expect(names).not.toContain("codex");
    expect(names).toEqual(["codex.COM", "codex.EXE", "codex.BAT", "codex.CMD"]);
  });

  it("leaves a name that already carries a PATHEXT extension alone", () => {
    expect(buildPathCommandNames("codex.cmd", { PATHEXT }, "win32")).toEqual([
      "codex.cmd",
    ]);
    // Case-insensitive against PATHEXT.
    expect(buildPathCommandNames("codex.CMD", { PATHEXT }, "win32")).toEqual([
      "codex.CMD",
    ]);
  });

  it("keeps a non-PATHEXT extension as a last resort, never first", () => {
    // `.PS1` is not in the default PATHEXT, so `codex.ps1` is not startable —
    // but the caller named a specific file, so it stays discoverable, last.
    const names = buildPathCommandNames("codex.ps1", { PATHEXT }, "win32");
    expect(names.at(-1)).toBe("codex.ps1");
    expect(names[0]).toBe("codex.ps1.COM");
  });

  it("reads PATHEXT case-insensitively and normalizes bare extensions", () => {
    expect(buildPathCommandNames("codex", { PathExt: "EXE;.cmd" }, "win32")).toEqual([
      "codex.EXE",
      "codex.cmd",
    ]);
  });

  it("falls back to the Windows default when PATHEXT is unset", () => {
    expect(buildPathCommandNames("codex", {}, "win32")).toEqual([
      "codex.COM",
      "codex.EXE",
      "codex.BAT",
      "codex.CMD",
    ]);
  });

  it("leaves POSIX resolution untouched — the bare name is the only option", () => {
    expect(buildPathCommandNames("codex", { PATHEXT }, "linux")).toEqual(["codex"]);
    expect(buildPathCommandNames("codex", { PATHEXT }, "darwin")).toEqual(["codex"]);
    // A dotted name is NOT an extension to expand off win32.
    expect(buildPathCommandNames("python3.11", {}, "linux")).toEqual(["python3.11"]);
  });
});

describe.runIf(isWindows)("Windows PATHEXT expansion (win32 host)", () => {
  it("expands a bare command to PATHEXT variants and resolves the .cmd shim", async () => {
    const binDir = mkdtempSync(path.join(tmpdir(), "cmddisc-win-"));
    try {
      const cmdShim = path.join(binDir, "wintool.cmd");
      writeFileSync(cmdShim, "@echo wintool 2.0.0\n", "utf8");

      const snapshot = await discoverCommands<"path">({
        // win32 reads PATH case-insensitively.
        env: { Path: binDir, PATHEXT: ".COM;.EXE;.BAT;.CMD" },
        platform: "win32",
        fixedCandidates: [],
        autoCandidates: [{ command: "wintool", source: "path" }],
        parseVersion: parseSimpleVersion,
        includeFailedAutoCandidates: true,
      });
      const candidate = snapshot.candidates.find((c) => c.source === "path");
      expect(candidate?.command.toLowerCase()).toBe(cmdShim.toLowerCase());
      expect(candidate?.executable).toBe(true);
      expect(candidate?.version).toBe("2.0.0");
      expect(snapshot.selectedCommand?.toLowerCase()).toBe(cmdShim.toLowerCase());
    } finally {
      rmSync(binDir, { recursive: true, force: true });
    }
  });

  it("resolves codex.cmd past the extensionless sh shim npm installs beside it", async () => {
    const binDir = mkdtempSync(path.join(tmpdir(), "cmddisc-win-"));
    try {
      // Exactly the layout `where codex` reports on an nvm-windows install:
      // the sh script first, the runnable shim second.
      writeFileSync(path.join(binDir, "codex"), "#!/bin/sh\necho nope\n", "utf8");
      const cmdShim = path.join(binDir, "codex.cmd");
      writeFileSync(cmdShim, "@echo codex-cli 0.146.0\n", "utf8");

      const snapshot = await discoverCommands<"path">({
        env: { Path: binDir, PATHEXT: ".COM;.EXE;.BAT;.CMD" },
        platform: "win32",
        fixedCandidates: [],
        autoCandidates: [{ command: "codex", source: "path" }],
        parseVersion: parseSimpleVersion,
        includeFailedAutoCandidates: true,
      });

      const candidate = snapshot.candidates.find((c) => c.source === "path");
      expect(candidate?.command.toLowerCase()).toBe(cmdShim.toLowerCase());
      expect(candidate?.executable).toBe(true);
      expect(candidate?.version).toBe("0.146.0");
      expect(snapshot.selectedCommand?.toLowerCase()).toBe(cmdShim.toLowerCase());
    } finally {
      rmSync(binDir, { recursive: true, force: true });
    }
  });

  it("keeps version arguments as data when probing an npm-style .cmd shim", async () => {
    const rootDir = mkdtempSync(path.join(tmpdir(), "cmddisc-win-"));
    const binDir = path.join(rootDir, "NVM & npm");
    const marker = path.join(rootDir, "injected.txt");
    try {
      mkdirSync(binDir, { recursive: true });
      const cmdShim = path.join(binDir, "wintool.cmd");
      const script = path.join(binDir, "wintool.js");
      const dangerousArgument = `probe & echo injected>"${marker}"`;
      writeFileSync(
        script,
        `console.log("wintool 2.0.0", JSON.stringify(process.argv.slice(2)));\n`,
        "utf8",
      );
      writeFileSync(
        cmdShim,
        `@ECHO off\nSETLOCAL\nnode "%~dp0\\wintool.js" %*\n`,
        "utf8",
      );

      const env = { ...process.env };
      for (const key of Object.keys(env)) {
        if (key.toLowerCase() === "path") delete env[key];
      }
      env.Path = `${binDir};${path.dirname(process.execPath)}`;
      env.PATHEXT = ".COM;.EXE;.BAT;.CMD";

      const snapshot = await discoverCommands<"path">({
        env,
        platform: "win32",
        fixedCandidates: [],
        autoCandidates: [{ command: "wintool", source: "path" }],
        versionArgs: ["--version", dangerousArgument],
        parseVersion: parseSimpleVersion,
      });

      expect(snapshot.selectedCommand?.toLowerCase()).toBe(cmdShim.toLowerCase());
      expect(snapshot.candidates[0]?.version).toBe("2.0.0");
      expect(existsSync(marker)).toBe(false);
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  });
});

describe.skipIf(isWindows)("Windows PATHEXT expansion (non-win32 host)", () => {
  it("takes the win32 branch and still produces a candidate", async () => {
    const binDir = mkdtempSync(path.join(tmpdir(), "cmddisc-win-"));
    try {
      // The file exists at a POSIX path; win32 join won't match it on a mac
      // host, so resolution falls back to the bare name. We assert a candidate
      // is produced (the win32 code path ran without throwing) rather than the
      // exact resolved path.
      writeFileSync(path.join(binDir, "wintool.cmd"), "@echo hi\n", "utf8");
      const snapshot = await discoverCommands<"path">({
        env: { Path: binDir, PATHEXT: ".COM;.EXE;.BAT;.CMD" },
        platform: "win32",
        fixedCandidates: [],
        autoCandidates: [{ command: "wintool", source: "path" }],
        parseVersion: parseSimpleVersion,
        includeFailedAutoCandidates: true,
      });
      const candidate = snapshot.candidates.find((c) => c.source === "path");
      expect(candidate).toBeDefined();
      expect(candidate?.command).toBe("wintool");
    } finally {
      rmSync(binDir, { recursive: true, force: true });
    }
  });
});

describe.skipIf(isWindows)("resolveDiscoveredCommand", () => {
  it("returns the selected candidate from the discovery snapshot", async () => {
    const binDir = makeTempDir();
    try {
      const tool = path.join(binDir, "res");
      writeFileSync(tool, `#!/bin/sh\necho "res 3.2.1"\n`, "utf8");
      chmodSync(tool, 0o755);

      const resolved = await resolveDiscoveredCommand<"path">({
        command: tool,
        fallbackSource: "path",
        discover: () =>
          discoverCommands<"path">({
            env: { PATH: binDir },
            platform: "linux",
            fixedCandidates: [],
            autoCandidates: [{ command: tool, source: "path" }],
            parseVersion: parseSimpleVersion,
          }),
      });
      expect(resolved.command).toBe(tool);
      expect(resolved.version).toBe("3.2.1");
    } finally {
      rmSync(binDir, { recursive: true, force: true });
    }
  });

  it("falls back to the basename when discovery selects nothing", async () => {
    const emptyDir = makeTempDir();
    try {
      const resolved = await resolveDiscoveredCommand<"path">({
        command: "ghost",
        fallbackSource: "path",
        discover: () =>
          discoverCommands<"path">({
            env: { PATH: emptyDir },
            platform: "linux",
            fixedCandidates: [],
            autoCandidates: [{ command: "ghost", source: "path" }],
            parseVersion: parseSimpleVersion,
          }),
      });
      expect(resolved.command).toBe("ghost");
      expect(resolved.source).toBe("path");
    } finally {
      rmSync(emptyDir, { recursive: true, force: true });
    }
  });
});

describe.skipIf(isWindows)("pathIsExecutable", () => {
  it("reports true for an executable file and false otherwise", async () => {
    const dir = makeTempDir();
    try {
      const exe = path.join(dir, "exe");
      writeFileSync(exe, "#!/bin/sh\n", "utf8");
      chmodSync(exe, 0o755);
      const notExe = path.join(dir, "data");
      writeFileSync(notExe, "hi", "utf8");
      chmodSync(notExe, 0o644);

      expect(await pathIsExecutable(exe)).toBe(true);
      expect(await pathIsExecutable(notExe)).toBe(false);
      expect(await pathIsExecutable(path.join(dir, "missing"))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// `access(X_OK)` is meaningless on Windows — it degrades to "does this file
// exist", so it answers true for a README. Startability there is the
// extension, and these assertions run on any host because the function is
// handed an already-resolved path (no win32 path joining involved).
describe("pathIsExecutable (win32 semantics)", () => {
  it("judges by PATHEXT, not by the (absent) execute bit", async () => {
    const dir = makeTempDir();
    try {
      const shShim = path.join(dir, "codex");
      writeFileSync(shShim, "#!/bin/sh\n", "utf8");
      chmodSync(shShim, 0o755);
      const cmdShim = path.join(dir, "codex.cmd");
      writeFileSync(cmdShim, "@echo hi\n", "utf8");
      const readme = path.join(dir, "README.md");
      writeFileSync(readme, "hi", "utf8");

      const env = { PATHEXT: ".COM;.EXE;.BAT;.CMD" };
      expect(await pathIsExecutable(cmdShim, { env, platform: "win32" })).toBe(true);
      // Executable bit set, and still not startable on Windows.
      expect(await pathIsExecutable(shShim, { env, platform: "win32" })).toBe(false);
      expect(await pathIsExecutable(readme, { env, platform: "win32" })).toBe(false);
      expect(
        await pathIsExecutable(path.join(dir, "missing.cmd"), { env, platform: "win32" }),
      ).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
