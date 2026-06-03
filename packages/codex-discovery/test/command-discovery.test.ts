import { describe, it, expect } from "vitest";
import { rmSync, mkdtempSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  discoverCommands,
  resolveDiscoveredCommand,
  pathIsExecutable,
} from "../src/index";
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
      expect(candidate?.command).toBe(cmdShim);
    } finally {
      rmSync(binDir, { recursive: true, force: true });
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
