#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const REPOSITORY = "yohn-jp/suzukuri";
const REPOSITORY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function fail(message) {
  throw new Error(message);
}

function required(environment, key) {
  const value = environment[key];
  if (typeof value !== "string" || value.length === 0) fail(`${key} is required`);
  return value;
}

function packageMetadata(repositoryRoot) {
  const value = JSON.parse(readFileSync(path.join(repositoryRoot, "package.json"), "utf8"));
  if (value?.name !== "suzukuri" || typeof value.version !== "string" || value.version.length === 0) {
    fail("package.json must identify suzukuri and a non-empty version");
  }
  return { name: value.name, version: value.version };
}

function sha256(filePath) {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

function checkedOutSha(repositoryRoot) {
  const result = spawnSync("git", ["rev-parse", "HEAD"], {
    cwd: repositoryRoot,
    encoding: "utf8",
    shell: false,
  });
  if (result.error !== undefined || result.status !== 0) fail("could not resolve checked-out source SHA");
  return String(result.stdout ?? "").trim();
}

export function verifyReleaseCertification({ environment = process.env, repositoryRoot = REPOSITORY_ROOT } = {}) {
  if (required(environment, "GITHUB_REPOSITORY") !== REPOSITORY) {
    fail(`GITHUB_REPOSITORY must be ${REPOSITORY}`);
  }

  const sourceSha = required(environment, "RELEASE_SOURCE_SHA");
  const tag = required(environment, "RELEASE_TAG");
  const artifactPath = path.resolve(required(environment, "RELEASE_ARTIFACT_PATH"));
  const artifactSha256 = required(environment, "RELEASE_ARTIFACT_SHA256");

  if (!/^[0-9a-f]{40}$/u.test(sourceSha)) fail("RELEASE_SOURCE_SHA must be an exact lowercase commit SHA");
  if (!/^[0-9a-f]{64}$/u.test(artifactSha256)) fail("RELEASE_ARTIFACT_SHA256 must be a lowercase SHA-256 digest");
  if (!statSync(artifactPath).isFile()) fail("RELEASE_ARTIFACT_PATH must be a regular file");

  const metadata = packageMetadata(repositoryRoot);
  if (tag !== `v${metadata.version}`) fail(`release tag ${tag} does not match package version ${metadata.version}`);
  if (checkedOutSha(repositoryRoot) !== sourceSha) fail("checked-out source SHA does not match RELEASE_SOURCE_SHA");
  if (sha256(artifactPath) !== artifactSha256) fail("packed tarball digest does not match RELEASE_ARTIFACT_SHA256");

  return { passed: true, sourceSha, tag, artifactSha256, metadata };
}

function main() {
  try {
    const result = verifyReleaseCertification();
    console.log(JSON.stringify(result));
  } catch (error) {
    console.log(JSON.stringify({ passed: false, message: error instanceof Error ? error.message : String(error) }));
    process.exitCode = 1;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
