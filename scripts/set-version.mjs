#!/usr/bin/env node
/**
 * Sets one version on the three published packages and pins their
 * dependencies on each other to exactly that version. Exact pins because the
 * packages ship together, and because a caret range never matches a
 * pre-release ("^0.1.0" does not accept "0.1.0-alpha.1").
 *
 *   node scripts/set-version.mjs 0.1.0-alpha.1
 */
import { readFileSync, writeFileSync } from "node:fs";

const version = process.argv[2];
if (!version || !/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version)) {
  console.error("usage: node scripts/set-version.mjs <semver>");
  process.exit(1);
}
// The reference host is private but a workspace member: its dependencies on
// the packages must keep matching them, or npm goes to the registry.
const MANIFESTS = ["packages/protocol", "packages/server", "packages/phone", "apps/host"];
for (const dir of MANIFESTS) {
  const path = `${dir}/package.json`;
  const pkg = JSON.parse(readFileSync(path, "utf8"));
  if (dir.startsWith("packages/")) pkg.version = version;
  for (const field of ["dependencies", "peerDependencies", "devDependencies"]) {
    for (const dep of Object.keys(pkg[field] ?? {})) {
      if (dep.startsWith("@kapula/")) pkg[field][dep] = version;
    }
  }
  writeFileSync(path, JSON.stringify(pkg, null, 2) + "\n");
  console.log(dir.startsWith("packages/") ? `${pkg.name}@${version}` : `${pkg.name}: dependencies pinned`);
}
