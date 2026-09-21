import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { runTestCommand } from "./test-command.js";

interface Fixture {
  readonly repository: string;
  readonly producer: string;
  readonly config: string;
  readonly counter: string;
  readonly cleanup: () => void;
}

// The producer, config, and run counter live outside the fingerprinted
// repository: an in-repo counter would self-invalidate the cache on every
// producer run, since it is a non-ignored untracked file.
function fixture(prefix: string): Fixture {
  const workDirectory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const repository = path.join(workDirectory, "repo");
  fs.mkdirSync(repository);
  execFileSync("git", ["init", "--quiet"], { cwd: repository });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: repository });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: repository });
  fs.writeFileSync(path.join(repository, "source.txt"), "content");
  execFileSync("git", ["add", "source.txt"], { cwd: repository });
  execFileSync("git", ["commit", "-m", "init", "--quiet"], { cwd: repository });
  return {
    repository,
    producer: path.join(workDirectory, "producer.mjs"),
    config: path.join(workDirectory, "commands.json"),
    counter: path.join(workDirectory, "runs.count"),
    cleanup: () => fs.rmSync(workDirectory, { recursive: true, force: true }),
  };
}

const TAP_PASS = "TAP version 13\n1..1\n# tests 1\n# pass 1\n# fail 0\n# skipped 0\n# duration_ms 2\n";

test("a second unchanged invocation returns the prior bounded result without spawning the producer again", async () => {
  const { repository, producer, config, counter, cleanup } = fixture("suzukuri-test-cache-hit-");
  const originalCwd = process.cwd();
  const lines: string[] = [];
  const originalLog = console.log;
  fs.writeFileSync(
    producer,
    `import fs from "node:fs"; fs.appendFileSync(${JSON.stringify(counter)}, "x"); process.stdout.write(${JSON.stringify(TAP_PASS)});`,
  );
  fs.writeFileSync(config, JSON.stringify({ schemaVersion: 1, commands: { test: [process.execPath, producer] } }));
  console.log = (line: string) => lines.push(line);
  try {
    process.chdir(repository);
    const first = await runTestCommand({ positionals: [], options: { config } });
    assert.equal(first, 0);
    assert.equal(fs.readFileSync(counter, "utf8"), "x");

    const second = await runTestCommand({ positionals: [], options: { config } });
    assert.equal(second, 0);
    assert.equal(fs.readFileSync(counter, "utf8"), "x", "producer must not run a second time on a cache hit");

    const secondResult = JSON.parse(lines[1] ?? "{}") as Record<string, unknown>;
    assert.equal(secondResult.reused, true);
  } finally {
    process.chdir(originalCwd);
    console.log = originalLog;
    cleanup();
  }
});

test("an included byte change after a cache hit causes the producer to run again", async () => {
  const { repository, producer, config, counter, cleanup } = fixture("suzukuri-test-cache-invalidate-");
  const originalCwd = process.cwd();
  const originalLog = console.log;
  console.log = () => {};
  fs.writeFileSync(
    producer,
    `import fs from "node:fs"; fs.appendFileSync(${JSON.stringify(counter)}, "x"); process.stdout.write(${JSON.stringify(TAP_PASS)});`,
  );
  fs.writeFileSync(config, JSON.stringify({ schemaVersion: 1, commands: { test: [process.execPath, producer] } }));
  try {
    process.chdir(repository);
    await runTestCommand({ positionals: [], options: { config } });
    fs.writeFileSync(path.join(repository, "source.txt"), "changed");
    await runTestCommand({ positionals: [], options: { config } });
    assert.equal(fs.readFileSync(counter, "utf8"), "xx");
  } finally {
    process.chdir(originalCwd);
    console.log = originalLog;
    cleanup();
  }
});
