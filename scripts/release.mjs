#!/usr/bin/env node
/**
 * Publishes the three packages, in dependency order, under one version and
 * one dist-tag. Run `npm login` first. The working tree must be clean: the
 * script commits the version bump and tags it.
 *
 *   node scripts/release.mjs 0.1.0-alpha.1 next     # pre-release
 *   node scripts/release.mjs 0.1.0 latest           # stable
 *   node scripts/release.mjs 0.1.0 latest --dry-run # everything but publish
 */
import { execSync } from "node:child_process";

const [version, tag, ...flags] = process.argv.slice(2);
const dryRun = flags.includes("--dry-run");
if (!version || !tag) {
  console.error("usage: node scripts/release.mjs <semver> <dist-tag> [--dry-run]");
  process.exit(1);
}
if (tag === "latest" && version.includes("-")) {
  console.error("a pre-release version must not be tagged latest");
  process.exit(1);
}
const run = (cmd) => {
  console.log(`\n$ ${cmd}`);
  execSync(cmd, { stdio: "inherit" });
};

if (execSync("git status --porcelain").toString().trim()) {
  console.error("commit or stash your changes first");
  process.exit(1);
}
const restore = () => run("git checkout -- packages apps/host/package.json package-lock.json");
try {
  run(`node scripts/set-version.mjs ${version}`);
  run("npm install --package-lock-only");
  run("npm run build:packages");
  run("npx playwright test --project=unit");
  for (const name of ["protocol", "server", "phone"]) {
    run(`npm publish --workspace=packages/${name} --tag ${tag}${dryRun ? " --dry-run" : ""}`);
  }
} catch (e) {
  // Nothing published yet, or a publish failed part-way: either way the
  // version bump must not linger uncommitted.
  restore();
  throw e;
}
if (dryRun) {
  restore();
  console.log("\ndry run: versions restored, nothing published");
} else {
  run(`git commit -am "Release ${version}"`);
  run(`git tag v${version}`);
  console.log(`\npublished ${version} as ${tag}; push with: git push && git push --tags`);
}
