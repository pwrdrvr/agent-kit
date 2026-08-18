// The clients resolve their Codex binary through codex-discovery on first
// connect. `commandVersionTimeoutMs` is the only way a host can size that
// probe, and it is observable ONLY through the real discovery path —
// `transportFactory` short-circuits discovery entirely.

import { describe, it, expect } from "vitest";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { CodexThreadClient } from "../src/codex-thread-client";
import { CodexOneShotClient } from "../src/codex-oneshot-client";

const isWindows = process.platform === "win32";

/**
 * A `codex` that takes 3s to say anything. The delay runs inside
 * `process.execPath` rather than `sleep` so it needs no `PATH` lookup, and
 * so a killed probe dies instead of orphaning a sleeper.
 */
function writeSlowCodex(dir: string): string {
  const shim = path.join(dir, "codex");
  writeFileSync(
    shim,
    `#!${process.execPath}\nsetTimeout(() => { console.log("codex-cli 9.9.9"); }, 3000);\n`,
    "utf8",
  );
  chmodSync(shim, 0o755);
  return shim;
}

/** Drive the client far enough to force discovery + spawn, and report how long
 *  it took to come back. The spawned shim never speaks JSON-RPC, so the call
 *  always rejects — what matters is WHEN. */
async function timeFirstConnect(run: () => Promise<unknown>): Promise<number> {
  const startedAt = Date.now();
  await run().catch(() => undefined);
  return Date.now() - startedAt;
}

describe.skipIf(isWindows)("commandVersionTimeoutMs reaches codex-discovery", () => {
  it("CodexThreadClient sizes the version probe with the host's budget", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "agent-client-discovery-"));
    try {
      const shim = writeSlowCodex(dir);
      const client = new CodexThreadClient({
        command: shim,
        env: { PATH: dir },
        commandVersionTimeoutMs: 150,
        // Keep the post-discovery handshake short: the shim is not a real
        // Codex, so `initialize` can only ever time out.
        requestTimeoutMs: 300,
      });

      const elapsed = await timeFirstConnect(() => client.startThread({}));
      await client.close().catch(() => undefined);

      // Discovery gave up at ~150ms instead of waiting out the 3s shim, so the
      // whole attempt lands well inside a second. On the 10s default this
      // would sit through the shim's full 3s before even spawning.
      expect(elapsed).toBeLessThan(2_000);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("CodexOneShotClient sizes the version probe with the host's budget", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "agent-client-discovery-"));
    try {
      const shim = writeSlowCodex(dir);
      const client = new CodexOneShotClient({
        command: shim,
        env: { PATH: dir },
        workspaceDir: dir,
        commandVersionTimeoutMs: 150,
        requestTimeoutMs: 300,
      });

      const elapsed = await timeFirstConnect(() => client.run({ prompt: "hi" }));
      await client.close().catch(() => undefined);

      expect(elapsed).toBeLessThan(2_000);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
