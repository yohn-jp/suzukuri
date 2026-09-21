import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { verifyReleaseCertification } from "./verify-release-certification.mjs";

function initRepositoryFixture(version) {
  const repositoryRoot = mkdtempSync(path.join(tmpdir(), "suzukuri-release-cert-"));
  spawnSync("git", ["init", "--quiet"], { cwd: repositoryRoot });
  spawnSync("git", ["config", "user.email", "test@example.com"], { cwd: repositoryRoot });
  spawnSync("git", ["config", "user.name", "test"], { cwd: repositoryRoot });
  writeFileSync(path.join(repositoryRoot, "package.json"), JSON.stringify({ name: "suzukuri", version }));
  spawnSync("git", ["add", "."], { cwd: repositoryRoot });
  spawnSync("git", ["commit", "--quiet", "-m", "init"], { cwd: repositoryRoot });
  const sourceSha = spawnSync("git", ["rev-parse", "HEAD"], { cwd: repositoryRoot, encoding: "utf8" }).stdout.trim();

  const artifactPath = path.join(repositoryRoot, "artifact.tgz");
  writeFileSync(artifactPath, "tarball-bytes");
  const artifactSha256 = createHash("sha256").update("tarball-bytes").digest("hex");

  return { repositoryRoot, sourceSha, artifactPath, artifactSha256 };
}

function baseEnvironment(fixture, overrides = {}) {
  return {
    GITHUB_REPOSITORY: "yohn-jp/suzukuri",
    RELEASE_SOURCE_SHA: fixture.sourceSha,
    RELEASE_TAG: "v0.2.0",
    RELEASE_ARTIFACT_PATH: fixture.artifactPath,
    RELEASE_ARTIFACT_SHA256: fixture.artifactSha256,
    ...overrides,
  };
}

test("passes when release context matches the checked-out source and packed artifact", () => {
  const fixture = initRepositoryFixture("0.2.0");
  try {
    const result = verifyReleaseCertification({
      environment: baseEnvironment(fixture),
      repositoryRoot: fixture.repositoryRoot,
    });
    assert.equal(result.passed, true);
    assert.equal(result.sourceSha, fixture.sourceSha);
  } finally {
    rmSync(fixture.repositoryRoot, { recursive: true, force: true });
  }
});

test("fails when the release tag does not match package.json's version", () => {
  const fixture = initRepositoryFixture("0.2.0");
  try {
    assert.throws(
      () =>
        verifyReleaseCertification({
          environment: baseEnvironment(fixture, { RELEASE_TAG: "v9.9.9" }),
          repositoryRoot: fixture.repositoryRoot,
        }),
      /does not match package version/,
    );
  } finally {
    rmSync(fixture.repositoryRoot, { recursive: true, force: true });
  }
});

test("fails when the packed artifact digest does not match RELEASE_ARTIFACT_SHA256", () => {
  const fixture = initRepositoryFixture("0.2.0");
  try {
    assert.throws(
      () =>
        verifyReleaseCertification({
          environment: baseEnvironment(fixture, { RELEASE_ARTIFACT_SHA256: "0".repeat(64) }),
          repositoryRoot: fixture.repositoryRoot,
        }),
      /does not match RELEASE_ARTIFACT_SHA256/,
    );
  } finally {
    rmSync(fixture.repositoryRoot, { recursive: true, force: true });
  }
});

test("fails when GITHUB_REPOSITORY does not identify this repository", () => {
  const fixture = initRepositoryFixture("0.2.0");
  try {
    assert.throws(
      () =>
        verifyReleaseCertification({
          environment: baseEnvironment(fixture, { GITHUB_REPOSITORY: "someone-else/fork" }),
          repositoryRoot: fixture.repositoryRoot,
        }),
      /GITHUB_REPOSITORY must be/,
    );
  } finally {
    rmSync(fixture.repositoryRoot, { recursive: true, force: true });
  }
});
