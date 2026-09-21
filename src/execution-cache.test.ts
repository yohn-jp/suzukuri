import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { lookupExecutionCache, markResultReused } from "./execution-cache.js";

const CACHE_DIRECTORY = ".suzukuri/cache/execution-results";

function cacheEntryCount(directory: string): number {
  const target = path.join(directory, CACHE_DIRECTORY);
  if (!fs.existsSync(target)) return 0;
  return fs.readdirSync(target).filter((name) => name.endsWith(".json")).length;
}

function initRepository(prefix: string): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  execFileSync("git", ["init", "--quiet"], { cwd: directory });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: directory });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: directory });
  fs.writeFileSync(path.join(directory, "a.txt"), "alpha");
  execFileSync("git", ["add", "a.txt"], { cwd: directory });
  execFileSync("git", ["commit", "-m", "init", "--quiet"], { cwd: directory });
  return directory;
}

function cleanup(directory: string): void {
  fs.rmSync(directory, { recursive: true, force: true });
}

test("a lookup miss followed by a commit is served as a hit for identical content and command", async () => {
  const directory = initRepository("suzukuri-cache-hit-");
  try {
    const command = { argv: ["node", "producer.mjs"] as const };
    const miss = await lookupExecutionCache("test", command, { cwd: directory });
    assert.ok(miss !== undefined);
    assert.equal(miss.cached, undefined);

    await miss.commit({ exitCode: 0, signal: null, printed: { status: "passed" } });

    const hit = await lookupExecutionCache("test", command, { cwd: directory });
    assert.ok(hit !== undefined);
    assert.deepEqual(hit.cached, { exitCode: 0, signal: null, printed: { status: "passed" } });
  } finally {
    cleanup(directory);
  }
});

test("a one-byte included change invalidates the cached entry", async () => {
  const directory = initRepository("suzukuri-cache-invalidate-");
  try {
    const command = { argv: ["node", "producer.mjs"] as const };
    const before = await lookupExecutionCache("test", command, { cwd: directory });
    assert.ok(before !== undefined);
    await before.commit({ exitCode: 0, signal: null, printed: { status: "passed" } });

    fs.writeFileSync(path.join(directory, "a.txt"), "alphb");
    const after = await lookupExecutionCache("test", command, { cwd: directory });
    assert.ok(after !== undefined);
    assert.equal(after.cached, undefined);
  } finally {
    cleanup(directory);
  }
});

test("different producer definitions cannot reuse each other's cached result", async () => {
  const directory = initRepository("suzukuri-cache-separation-");
  try {
    const commandA = { argv: ["node", "a.mjs"] as const };
    const commandB = { argv: ["node", "b.mjs"] as const };
    const lookupA = await lookupExecutionCache("test", commandA, { cwd: directory });
    assert.ok(lookupA !== undefined);
    await lookupA.commit({ exitCode: 0, signal: null, printed: { status: "passed" } });

    const lookupB = await lookupExecutionCache("test", commandB, { cwd: directory });
    assert.ok(lookupB !== undefined);
    assert.equal(lookupB.cached, undefined);
  } finally {
    cleanup(directory);
  }
});

test("test and verify commands cannot reuse each other's cached result for the same producer definition", async () => {
  const directory = initRepository("suzukuri-cache-command-separation-");
  try {
    const command = { argv: ["node", "producer.mjs"] as const };
    const testLookup = await lookupExecutionCache("test", command, { cwd: directory });
    assert.ok(testLookup !== undefined);
    await testLookup.commit({ exitCode: 0, signal: null, printed: { status: "passed" } });

    const verifyLookup = await lookupExecutionCache("verify", command, { cwd: directory });
    assert.ok(verifyLookup !== undefined);
    assert.equal(verifyLookup.cached, undefined);
  } finally {
    cleanup(directory);
  }
});

test("a failed result is reusable while execution identity remains identical", async () => {
  const directory = initRepository("suzukuri-cache-failed-reuse-");
  try {
    const command = { argv: ["node", "producer.mjs"] as const };
    const lookup = await lookupExecutionCache("verify", command, { cwd: directory });
    assert.ok(lookup !== undefined);
    await lookup.commit({ exitCode: 1, signal: null, printed: { status: "failed", stage: "lint" } });

    const hit = await lookupExecutionCache("verify", command, { cwd: directory });
    assert.ok(hit !== undefined);
    assert.deepEqual(hit.cached, { exitCode: 1, signal: null, printed: { status: "failed", stage: "lint" } });
  } finally {
    cleanup(directory);
  }
});

test("fingerprint acquisition failure fails closed to a cache miss", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "suzukuri-cache-not-git-"));
  try {
    const command = { argv: ["node", "producer.mjs"] as const };
    const lookup = await lookupExecutionCache("test", command, { cwd: directory });
    assert.equal(lookup, undefined);
  } finally {
    cleanup(directory);
  }
});

test("a repository content change between lookup and commit is not cached", async () => {
  const directory = initRepository("suzukuri-cache-race-");
  try {
    const command = { argv: ["node", "producer.mjs"] as const };
    const lookup = await lookupExecutionCache("test", command, { cwd: directory });
    assert.ok(lookup !== undefined);

    // Simulate a producer that mutates the working tree while it runs:
    // content observed by the caller after this lookup no longer matches
    // what the lookup's fingerprint was computed from.
    fs.writeFileSync(path.join(directory, "a.txt"), "mutated-during-producer-run");
    await lookup.commit({ exitCode: 0, signal: null, printed: { status: "passed" } });

    // Re-run against the now-current content: must be a miss, since the
    // stale-fingerprint commit above must not have been stored.
    const afterMutation = await lookupExecutionCache("test", command, { cwd: directory });
    assert.ok(afterMutation !== undefined);
    assert.equal(afterMutation.cached, undefined);

    // Restoring the original content must also miss: a result keyed on the
    // original fingerprint was never actually stored.
    fs.writeFileSync(path.join(directory, "a.txt"), "alpha");
    const restored = await lookupExecutionCache("test", command, { cwd: directory });
    assert.ok(restored !== undefined);
    assert.equal(restored.cached, undefined);
  } finally {
    cleanup(directory);
  }
});

test("markResultReused adds a reused marker to object results and leaves other shapes untouched", () => {
  assert.deepEqual(markResultReused({ status: "passed" }), { status: "passed", reused: true });
  assert.equal(markResultReused("text"), "text");
  assert.deepEqual(markResultReused([1, 2]), [1, 2]);
  assert.equal(markResultReused(null), null);
});

test("cache state is bounded: it never grows past the configured maximum entry count", async () => {
  const directory = initRepository("suzukuri-cache-bounded-");
  try {
    const maxEntries = 3;
    for (let index = 0; index < maxEntries + 5; index += 1) {
      fs.writeFileSync(path.join(directory, "a.txt"), `alpha-${index}`);
      const command = { argv: ["node", `producer-${index}.mjs`] as const };
      const lookup = await lookupExecutionCache("test", command, { cwd: directory, maxEntries });
      assert.ok(lookup !== undefined);
      await lookup.commit({ exitCode: 0, signal: null, printed: { status: "passed", index } });
      assert.ok(cacheEntryCount(directory) <= maxEntries, `entry count must never exceed ${maxEntries}`);
    }
    assert.equal(cacheEntryCount(directory), maxEntries);
  } finally {
    cleanup(directory);
  }
});

test("bounded eviction discards the oldest entries first and keeps the most recent reusable", async () => {
  const directory = initRepository("suzukuri-cache-evict-oldest-");
  try {
    const maxEntries = 2;
    const command = (index: number) => ({ argv: ["node", `producer-${index}.mjs`] as const });
    for (let index = 0; index < 3; index += 1) {
      fs.writeFileSync(path.join(directory, "a.txt"), `alpha-${index}`);
      const lookup = await lookupExecutionCache("test", command(index), { cwd: directory, maxEntries });
      assert.ok(lookup !== undefined);
      await lookup.commit({ exitCode: 0, signal: null, printed: { status: "passed", index } });
    }

    // The first command's cached entry (written against the first content)
    // should have been evicted; the most recent two remain reusable.
    fs.writeFileSync(path.join(directory, "a.txt"), "alpha-0");
    const oldest = await lookupExecutionCache("test", command(0), { cwd: directory, maxEntries });
    assert.ok(oldest !== undefined);
    assert.equal(oldest.cached, undefined);

    fs.writeFileSync(path.join(directory, "a.txt"), "alpha-2");
    const newest = await lookupExecutionCache("test", command(2), { cwd: directory, maxEntries });
    assert.ok(newest !== undefined);
    assert.deepEqual(newest.cached?.printed, { status: "passed", index: 2 });
  } finally {
    cleanup(directory);
  }
});
