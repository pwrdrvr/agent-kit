// Oracle: each SDK-free subpath export loads without `@agentclientprotocol/sdk`.
//
// A host (PwrAgent's headless owner) reads the strategy table, runs discovery
// and normalizes MCP server configs at start, before any ACP connection
// exists. Before the subpaths, those helpers were reachable only through the
// root bundle, whose top-level SDK import cost ~30 ms of cold loading on every
// start. This test loads the BUILT package (what a host installs) in a fresh
// Node process and records every module Node resolves. The root entry is the
// control: it must load the SDK, or the probe is not seeing anything.
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const packageDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SDK = "@agentclientprotocol/sdk";

const PROBE = `
import { registerHooks } from "node:module";
const resolved = [];
registerHooks({
  resolve(specifier, context, nextResolve) {
    const result = nextResolve(specifier, context);
    resolved.push(result.url);
    return result;
  }
});
await import(process.argv[1]);
process.stdout.write(JSON.stringify(resolved));
`;

async function resolvedUrlsFor(specifier: string): Promise<string[]> {
  const { stdout } = await execFileAsync(
    process.execPath,
    ["--input-type=module", "-e", PROBE, specifier],
    { cwd: packageDir }
  );
  return JSON.parse(stdout) as string[];
}

const loadsSdk = (urls: string[]) =>
  urls.some(url => url.includes(`/node_modules/${SDK}/`));

describe("SDK-free subpath exports", () => {
  it("has a build to probe", () => {
    expect(
      existsSync(path.join(packageDir, "dist", "index.js")),
      "run `pnpm build` first: this test loads the published entry points"
    ).toBe(true);
  });

  it("loads the SDK from the root entry (control)", async () => {
    expect(loadsSdk(await resolvedUrlsFor("@pwrdrvr/agent-acp"))).toBe(true);
  });

  it.each([
    "@pwrdrvr/agent-acp/strategies",
    "@pwrdrvr/agent-acp/discovery",
    "@pwrdrvr/agent-acp/mcp-server-config"
  ])("%s does not load the SDK", async specifier => {
    const urls = await resolvedUrlsFor(specifier);
    expect(urls.some(url => url.includes("/agent-acp/dist/"))).toBe(true);
    expect(urls.filter(url => url.includes(SDK))).toEqual([]);
  });
});
