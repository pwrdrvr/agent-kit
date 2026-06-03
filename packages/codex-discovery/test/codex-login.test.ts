import { describe, it, expect, vi } from "vitest";
import { rmSync, writeFileSync, chmodSync } from "node:fs";
import path from "node:path";
import {
  collectCodexStatus,
  checkCodexAuthStatus,
  parseCodexLoginPrompt,
  CodexLoginManager,
} from "../src/index";
import { makeTempDir, writeFakeCodex, makeFakeJwt, writeAuthJson } from "./helpers";

const isWindows = process.platform === "win32";

describe("parseCodexLoginPrompt", () => {
  it("scrapes the OAuth authorize URL from output", () => {
    const out =
      "Some preamble\nOpen https://auth.openai.com/oauth/authorize?client_id=x&code=y to continue\n";
    expect(parseCodexLoginPrompt(out).loginUrl).toBe(
      "https://auth.openai.com/oauth/authorize?client_id=x&code=y",
    );
  });

  it("returns {} when no URL is present", () => {
    expect(parseCodexLoginPrompt("no url here")).toEqual({});
  });
});

describe.skipIf(isWindows)("collectCodexStatus / checkCodexAuthStatus", () => {
  it("reports authenticated (exit 0) when the CODEX_HOME is logged in", async () => {
    const binDir = makeTempDir();
    const codexHome = makeTempDir();
    try {
      const codex = writeFakeCodex({ dir: binDir });
      // Marker file the shim checks for `login status` exit 0, plus an
      // auth.json so the JWT identity surfaces.
      writeFileSync(path.join(codexHome, "logged-in"), "", "utf8");
      writeAuthJson(
        codexHome,
        makeFakeJwt({ email: "me@example.com", chatgpt_plan_type: "team" }),
      );

      const raw = await collectCodexStatus(codex, codexHome);
      expect(raw.code).toBe(0);

      const status = await checkCodexAuthStatus({
        command: codex,
        codexHome,
        profile: "",
      });
      expect(status.authenticated).toBe(true);
      expect(status.status).toBe("authenticated");
      expect(status.email).toBe("me@example.com");
      expect(status.planType).toBe("team");
    } finally {
      rmSync(binDir, { recursive: true, force: true });
      rmSync(codexHome, { recursive: true, force: true });
    }
  });

  it("reports unauthenticated (non-zero exit) when not logged in", async () => {
    const binDir = makeTempDir();
    const codexHome = makeTempDir();
    try {
      const codex = writeFakeCodex({ dir: binDir });
      const status = await checkCodexAuthStatus({
        command: codex,
        codexHome,
        profile: "work",
      });
      expect(status.authenticated).toBe(false);
      expect(status.status).toBe("unauthenticated");
      expect(status.email).toBeUndefined();
    } finally {
      rmSync(binDir, { recursive: true, force: true });
      rmSync(codexHome, { recursive: true, force: true });
    }
  });

  it("reports failed when the command cannot be spawned", async () => {
    const codexHome = makeTempDir();
    try {
      const status = await checkCodexAuthStatus({
        command: path.join(makeTempDir(), "does-not-exist"),
        codexHome,
        profile: "",
      });
      expect(status.status).toBe("failed");
      expect(status.authenticated).toBe(false);
    } finally {
      rmSync(codexHome, { recursive: true, force: true });
    }
  });
});

describe.skipIf(isWindows)("CodexLoginManager.startProfileLogin", () => {
  it("scrapes the OAuth URL and invokes the injected openExternal", async () => {
    const binDir = makeTempDir();
    const codexHome = makeTempDir();
    try {
      const codex = writeFakeCodex({ dir: binDir });
      const openExternal = vi.fn(async () => {});
      const manager = new CodexLoginManager({ openExternal });

      const result = await manager.startProfileLogin({
        command: codex,
        codexHome,
        profile: "work",
      });

      expect(result.started).toBe(true);
      expect(result.loginUrl).toMatch(
        /^https:\/\/auth\.openai\.com\/oauth\/authorize/,
      );
      expect(openExternal).toHaveBeenCalledTimes(1);
      expect(openExternal).toHaveBeenCalledWith(result.loginUrl);
      manager.dispose();
    } finally {
      rmSync(binDir, { recursive: true, force: true });
      rmSync(codexHome, { recursive: true, force: true });
    }
  });

  it("re-invocation kills the prior login child for the same profile", async () => {
    const binDir = makeTempDir();
    const codexHome = makeTempDir();
    try {
      // A shim that prints NO url and sleeps, so the first login stays alive
      // (resolves only via the 8s timeout) and we can observe it being killed
      // when the second login for the same profile starts.
      const sleeper = path.join(binDir, "codex");
      writeFileSync(
        sleeper,
        `#!/bin/sh
if [ "$1" = "login" ] && [ "$2" = "status" ]; then
  echo "Not logged in"
  exit 1
fi
if [ "$1" = "login" ]; then
  # Emit the URL immediately so startProfileLogin resolves, then keep
  # running so the child stays alive and killable.
  echo "Open https://auth.openai.com/oauth/authorize?code=first"
  sleep 30
  exit 0
fi
exit 0
`,
        "utf8",
      );
      chmodSync(sleeper, 0o755);

      const manager = new CodexLoginManager({ openExternal: async () => {} });

      const first = await manager.startProfileLogin({
        command: sleeper,
        codexHome,
        profile: "work",
      });
      expect(first.pid).toBeDefined();
      const firstPid = first.pid!;
      // The first child is still running (sleep 30).
      expect(() => process.kill(firstPid, 0)).not.toThrow();

      // Re-invoke for the same profile — should kill the prior child.
      const second = await manager.startProfileLogin({
        command: sleeper,
        codexHome,
        profile: "work",
      });
      expect(second.pid).toBeDefined();
      expect(second.pid).not.toBe(firstPid);

      // Give the SIGTERM a moment to land, then assert the first pid is gone.
      await vi.waitFor(() => {
        let alive = false;
        try {
          process.kill(firstPid, 0);
          alive = true;
        } catch {
          alive = false;
        }
        expect(alive).toBe(false);
      }, { timeout: 2_000 });

      manager.dispose();
    } finally {
      rmSync(binDir, { recursive: true, force: true });
      rmSync(codexHome, { recursive: true, force: true });
    }
  });

  it("resolves via the URL-surface timeout when login never prints a URL", async () => {
    const binDir = makeTempDir();
    const codexHome = makeTempDir();
    // Inject a tiny URL-surface timeout so the path is exercised deterministically
    // and fast (the default is 8s, which would exceed vitest's 5s test timeout).
    const manager = new CodexLoginManager({ loginUrlTimeoutMs: 100 });
    try {
      // A shim that emits no OAuth URL and stays alive past the timeout.
      const noUrl = path.join(binDir, "codex");
      writeFileSync(
        noUrl,
        `#!/bin/sh
echo "working..."
sleep 30
`,
        "utf8",
      );
      chmodSync(noUrl, 0o755);

      const result = await manager.startProfileLogin({
        command: noUrl,
        codexHome,
        profile: "p",
      });
      // No URL ever surfaced → resolves started:true via the timeout, no loginUrl.
      expect(result.started).toBe(true);
      expect(result.loginUrl).toBeUndefined();
      expect(result.profile).toBe("p");
      expect(result.codexHome).toBe(codexHome);
    } finally {
      manager.dispose(); // kill the lingering sleeper child
      rmSync(binDir, { recursive: true, force: true });
      rmSync(codexHome, { recursive: true, force: true });
    }
  });
});
