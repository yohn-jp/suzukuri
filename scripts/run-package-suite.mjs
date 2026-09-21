#!/usr/bin/env node
// Package-content validation: confirms `npm pack` includes exactly the files
// package.json's "files" field promises (no more, no less), then delegates
// install/exec verification to smoke-test.mjs against the same tarball.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: repoRoot, encoding: "utf8", ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} exited with ${result.status}`);
  return result;
}

// npm <12 reports `pack --json` results as a one-element array; npm >=12
// reports an object keyed by package name instead.
function parsePackInfo(stdout, packageName) {
  const parsed = JSON.parse(stdout);
  return Array.isArray(parsed) ? parsed[0] : parsed[packageName];
}

function main() {
  const distEntry = path.join(repoRoot, "dist", "index.js");
  if (!fs.existsSync(distEntry)) throw new Error("dist is missing; run pnpm run build before the package suite");

  // --ignore-scripts: dist is already built above; without this, npm's prepack
  // hook re-runs the build and chmod-bin.mjs's stdout log interleaves with
  // this command's --json output, breaking JSON.parse (npm >=10).
  const packageJson = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8"));
  const packResult = run("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"]);
  const packInfo = parsePackInfo(packResult.stdout, packageJson.name);
  const packedFiles = packInfo.files.map((entry) => entry.path);

  const executableBinPaths = Object.values(packageJson.bin ?? {});
  for (const binPath of executableBinPaths) {
    if (!packedFiles.includes(binPath)) {
      throw new Error(`bin entry "${binPath}" is not included in the packed tarball`);
    }
    const stat = fs.statSync(path.join(repoRoot, binPath));
    const isExecutableByOwner = (stat.mode & 0o100) !== 0;
    if (!isExecutableByOwner) {
      throw new Error(`bin entry "${binPath}" is not executable (chmod +x it, or check build step file perms)`);
    }
  }

  console.log(`package contents verified: ${packedFiles.length} file(s), all bin targets present and executable.`);

  run(process.execPath, ["scripts/conformance-report.mjs"], { stdio: "inherit" });
  run(process.execPath, ["scripts/smoke-test.mjs"], { stdio: "inherit" });
}

main();
