#!/usr/bin/env node
// Guard: certain dependencies must resolve to exactly ONE version across the
// whole workspace. A second copy is the kind of thing that silently creeps in
// (a transitive dep pins an older major) and turns into a "mess" — duplicate
// bundles, and worse, cross-instance `instanceof` / schema-identity failures
// when two copies of the same library meet at a package boundary.
//
// zod is the motivating case: `@zed-industries/agent-client-protocol` pins
// `zod@^3`, while `@pwrdrvr/agent-client` (and consumers) use `zod@^4`. We
// collapse that to a single zod via the root `pnpm.overrides.zod` (the zed lib
// validates cleanly under zod 4 — its schemas are exercised by agent-acp's
// acp-connection tests). This guard makes sure the collapse STAYS collapsed: if
// a future dependency bump reintroduces a second zod, CI fails here with a
// pointer to the fix instead of the duplicate shipping silently.
//
// Reads pnpm-lock.yaml (lockfileVersion 9). No yaml dependency — package keys
// are matched textually from the `packages:` section.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const lockPath = join(repoRoot, "pnpm-lock.yaml");

/** Dependencies that must resolve to exactly one version workspace-wide.
 *  Add a name here when a duplicate copy would be a correctness or footprint
 *  hazard (shared singletons, schema/identity-sensitive libs). */
const SINGLE_VERSION_DEPS = ["zod"];

/** Per-dep remediation hint shown when the guard trips. */
const FIX_HINTS = {
  zod:
    'add/adjust the root `pnpm.overrides.zod` (e.g. "^4.0.0") so the transitive ' +
    "copy collapses onto the first-party one, then re-run `pnpm install`."
};

function collectVersionsFromLock(lockText) {
  // The `packages:` section lists every resolved package as a top-level key:
  //   packages:
  //     zod@4.4.3:
  //       resolution: {...}
  // Peer-suffixed keys look like `name@1.2.3(peer@4.5.6)`; we strip the suffix.
  const versions = new Map(); // name -> Set<version>
  const packagesIdx = lockText.indexOf("\npackages:\n");
  if (packagesIdx === -1) return versions;
  const section = lockText.slice(packagesIdx);
  const keyRe = /^ {2}((?:@[^/\s]+\/)?[^@\s/][^@\s]*)@([^():\s]+)(?:\([^)]*\))*:\s*$/gm;
  let m;
  while ((m = keyRe.exec(section)) !== null) {
    const [, name, version] = m;
    if (!SINGLE_VERSION_DEPS.includes(name)) continue;
    if (!versions.has(name)) versions.set(name, new Set());
    versions.get(name).add(version);
  }
  return versions;
}

let lockText;
try {
  lockText = readFileSync(lockPath, "utf8");
} catch (err) {
  console.error(`check-single-version-deps: cannot read ${lockPath}: ${err.message}`);
  process.exit(2);
}

const versions = collectVersionsFromLock(lockText);
const offenders = [];
for (const name of SINGLE_VERSION_DEPS) {
  const found = versions.get(name);
  if (found && found.size > 1) {
    offenders.push({ name, versions: [...found].sort() });
  }
}

if (offenders.length > 0) {
  console.error("✗ Duplicate versions of single-version-pinned dependencies found:\n");
  for (const { name, versions: vs } of offenders) {
    console.error(`  ${name}: ${vs.join(", ")}`);
    const hint = FIX_HINTS[name];
    if (hint) console.error(`    → ${hint}`);
    console.error(`    → inspect with: pnpm why -r ${name}\n`);
  }
  process.exit(1);
}

const summary = SINGLE_VERSION_DEPS.map((n) => {
  const v = versions.get(n);
  return `${n}@${v ? [...v][0] : "(absent)"}`;
}).join(", ");
console.log(`✓ single-version deps OK: ${summary}`);
