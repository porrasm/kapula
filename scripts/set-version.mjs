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
const PACKAGES = ["protocol", "server", "phone"];
for (const name of PACKAGES) {
  const path = `packages/${name}/package.json`;
  const pkg = JSON.parse(readFileSync(path, "utf8"));
  pkg.version = version;
  for (const field of ["dependencies", "peerDependencies", "devDependencies"]) {
    for (const dep of Object.keys(pkg[field] ?? {})) {
      if (dep.startsWith("@kapula/")) pkg[field][dep] = version;
    }
  }
  writeFileSync(path, JSON.stringify(pkg, null, 2) + "\n");
  console.log(`${pkg.name}@${version}`);
}
