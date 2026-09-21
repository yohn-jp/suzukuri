import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { computeRepositoryFingerprint, RepositoryFingerprintError } from "./repository-fingerprint.js";

function initRepository(prefix: string): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  execFileSync("git", ["init", "--quiet"], { cwd: directory });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: directory });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: directory });
  return directory;
}

function cleanup(directory: string): void {
  fs.rmSync(directory, { recursive: true, force: true });
}

test("fingerprint is deterministic for identical tracked and non-ignored untracked content", async () => {
  const directory = initRepository("suzukuri-fingerprint-stable-");
  try {
    fs.writeFileSync(path.join(directory, "a.txt"), "alpha");
    fs.writeFileSync(path.join(directory, "b.txt"), "beta");
    execFileSync("git", ["add", "a.txt"], { cwd: directory });
    execFileSync("git", ["commit", "-m", "init", "--quiet"], { cwd: directory });
    fs.writeFileSync(path.join(directory, "untracked.txt"), "gamma");
    const first = await computeRepositoryFingerprint(directory);
    const second = await computeRepositoryFingerprint(directory);
    assert.equal(first, second);
  } finally {
    cleanup(directory);
  }
});

test("a one-byte content change invalidates the fingerprint", async () => {
  const directory = initRepository("suzukuri-fingerprint-byte-");
  try {
    const target = path.join(directory, "a.txt");
    fs.writeFileSync(target, "alpha");
    execFileSync("git", ["add", "a.txt"], { cwd: directory });
    execFileSync("git", ["commit", "-m", "init", "--quiet"], { cwd: directory });
    const before = await computeRepositoryFingerprint(directory);
    fs.writeFileSync(target, "alphb");
    const after = await computeRepositoryFingerprint(directory);
    assert.notEqual(before, after);
  } finally {
    cleanup(directory);
  }
});

test("adding, deleting, or renaming an included file invalidates the fingerprint", async () => {
  const directory = initRepository("suzukuri-fingerprint-structure-");
  try {
    fs.writeFileSync(path.join(directory, "a.txt"), "alpha");
    execFileSync("git", ["add", "a.txt"], { cwd: directory });
    execFileSync("git", ["commit", "-m", "init", "--quiet"], { cwd: directory });
    const base = await computeRepositoryFingerprint(directory);

    fs.writeFileSync(path.join(directory, "untracked-new.txt"), "new");
    const afterAdd = await computeRepositoryFingerprint(directory);
    assert.notEqual(base, afterAdd);
    fs.rmSync(path.join(directory, "untracked-new.txt"));

    fs.renameSync(path.join(directory, "a.txt"), path.join(directory, "a-renamed.txt"));
    execFileSync("git", ["add", "-A"], { cwd: directory });
    const afterRename = await computeRepositoryFingerprint(directory);
    assert.notEqual(base, afterRename);
    fs.renameSync(path.join(directory, "a-renamed.txt"), path.join(directory, "a.txt"));
    execFileSync("git", ["add", "-A"], { cwd: directory });

    fs.rmSync(path.join(directory, "a.txt"));
    execFileSync("git", ["add", "-A"], { cwd: directory });
    const afterDelete = await computeRepositoryFingerprint(directory);
    assert.notEqual(base, afterDelete);
  } finally {
    cleanup(directory);
  }
});

test("ignored-file-only changes do not invalidate the fingerprint", async () => {
  const directory = initRepository("suzukuri-fingerprint-ignored-");
  try {
    fs.writeFileSync(path.join(directory, ".gitignore"), "ignored.txt\n");
    fs.writeFileSync(path.join(directory, "a.txt"), "alpha");
    execFileSync("git", ["add", "a.txt", ".gitignore"], { cwd: directory });
    execFileSync("git", ["commit", "-m", "init", "--quiet"], { cwd: directory });
    const before = await computeRepositoryFingerprint(directory);
    fs.writeFileSync(path.join(directory, "ignored.txt"), "should not count");
    const after = await computeRepositoryFingerprint(directory);
    assert.equal(before, after);
  } finally {
    cleanup(directory);
  }
});

test("identical content in two distinct worktree directories produces the same fingerprint", async () => {
  const first = initRepository("suzukuri-fingerprint-worktree-a-");
  const second = initRepository("suzukuri-fingerprint-worktree-b-");
  try {
    for (const directory of [first, second]) {
      fs.mkdirSync(path.join(directory, "nested"), { recursive: true });
      fs.writeFileSync(path.join(directory, "a.txt"), "alpha");
      fs.writeFileSync(path.join(directory, "nested", "b.txt"), "beta");
      execFileSync("git", ["add", "a.txt", "nested/b.txt"], { cwd: directory });
      execFileSync("git", ["commit", "-m", "init", "--quiet"], { cwd: directory });
    }
    const fingerprintFirst = await computeRepositoryFingerprint(first);
    const fingerprintSecond = await computeRepositoryFingerprint(second);
    assert.equal(fingerprintFirst, fingerprintSecond);
  } finally {
    cleanup(first);
    cleanup(second);
  }
});

test("fails closed when the directory is not a git repository", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "suzukuri-fingerprint-not-git-"));
  try {
    await assert.rejects(
      computeRepositoryFingerprint(directory),
      (error: unknown) => error instanceof RepositoryFingerprintError,
    );
  } finally {
    cleanup(directory);
  }
});

test("a symlink is fingerprinted by its link target, not the dereferenced content it points to", async () => {
  const directory = initRepository("suzukuri-fingerprint-symlink-target-");
  try {
    fs.writeFileSync(path.join(directory, "target-a.txt"), "same content");
    fs.writeFileSync(path.join(directory, "target-b.txt"), "same content");
    fs.symlinkSync("target-a.txt", path.join(directory, "link.txt"));
    execFileSync("git", ["add", "-A"], { cwd: directory });
    execFileSync("git", ["commit", "-m", "init", "--quiet"], { cwd: directory });
    const before = await computeRepositoryFingerprint(directory);

    // Both targets have identical content; only the link's target string
    // changes. Dereferencing the link would leave the fingerprint
    // unchanged, which is exactly the bug this asserts against.
    fs.rmSync(path.join(directory, "link.txt"));
    fs.symlinkSync("target-b.txt", path.join(directory, "link.txt"));
    execFileSync("git", ["add", "-A"], { cwd: directory });
    const after = await computeRepositoryFingerprint(directory);
    assert.notEqual(before, after);
  } finally {
    cleanup(directory);
  }
});

test("a symlink's fingerprint is independent of its target's content", async () => {
  const directory = initRepository("suzukuri-fingerprint-symlink-stable-");
  try {
    // The target lives outside the fingerprinted set (git-ignored) so only
    // the symlink's own contribution to the fingerprint is under test —
    // the target file's own tracked content would otherwise also change
    // the fingerprint, for an unrelated reason.
    fs.writeFileSync(path.join(directory, ".gitignore"), "target.txt\n");
    fs.writeFileSync(path.join(directory, "target.txt"), "original");
    fs.symlinkSync("target.txt", path.join(directory, "link.txt"));
    execFileSync("git", ["add", "-A"], { cwd: directory });
    execFileSync("git", ["commit", "-m", "init", "--quiet"], { cwd: directory });
    const before = await computeRepositoryFingerprint(directory);

    fs.writeFileSync(path.join(directory, "target.txt"), "changed");
    const after = await computeRepositoryFingerprint(directory);
    assert.equal(before, after);
  } finally {
    cleanup(directory);
  }
});

test("a symlink and a regular file with the same path-adjacent bytes do not alias to the same fingerprint", async () => {
  const symlinkDirectory = initRepository("suzukuri-fingerprint-symlink-kind-a-");
  const fileDirectory = initRepository("suzukuri-fingerprint-symlink-kind-b-");
  try {
    fs.symlinkSync("same-bytes", path.join(symlinkDirectory, "entry.txt"));
    execFileSync("git", ["add", "-A"], { cwd: symlinkDirectory });
    execFileSync("git", ["commit", "-m", "init", "--quiet"], { cwd: symlinkDirectory });

    fs.writeFileSync(path.join(fileDirectory, "entry.txt"), "same-bytes");
    execFileSync("git", ["add", "-A"], { cwd: fileDirectory });
    execFileSync("git", ["commit", "-m", "init", "--quiet"], { cwd: fileDirectory });

    const symlinkFingerprint = await computeRepositoryFingerprint(symlinkDirectory);
    const fileFingerprint = await computeRepositoryFingerprint(fileDirectory);
    assert.notEqual(symlinkFingerprint, fileFingerprint);
  } finally {
    cleanup(symlinkDirectory);
    cleanup(fileDirectory);
  }
});
