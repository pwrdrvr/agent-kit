#!/usr/bin/env node
// Fails if any workspace package.json does not declare "license": "MIT".
// agent-kit ships MIT-only; this gate keeps every published package compliant.
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const workspaceDirs = ["packages", "examples"];
const failures = [];

for (const dir of workspaceDirs) {
  const base = join(root, dir);
  if (!existsSync(base)) continue;
  for (const entry of readdirSync(base, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const pkgPath = join(base, entry.name, "package.json");
    if (!existsSync(pkgPath)) continue;
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
    if (pkg.private === true) continue; // private (unpublished) packages are exempt
    if (pkg.license !== "MIT") {
      failures.push(`${dir}/${entry.name}: license is ${JSON.stringify(pkg.license)} (expected "MIT")`);
    }
  }
}

if (failures.length > 0) {
  console.error("License policy violations:\n" + failures.map((f) => `  - ${f}`).join("\n"));
  process.exit(1);
}
console.log("License policy OK — all published packages declare MIT.");
