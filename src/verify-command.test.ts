import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { runCli } from "./cli.js";
import { runVerifyCommand } from "./verify-command.js";
import { VERIFY_RESULT_SCHEMA_VERSION, isVerifyResult, validateVerifyResult } from "./verify-result.js";

function fixture(prefix: string): { directory: string; producer: string; config: string } {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  return {
    directory,
    producer: path.join(directory, "producer.mjs"),
    config: path.join(directory, "commands.json"),
  };
}

interface GitFixture {
  readonly directory: string;
  readonly repository: string;
  readonly producer: string;
  readonly config: string;
  readonly counter: string;
}

// The producer, config, and run counter live outside the fingerprinted
// repository: an in-repo counter would self-invalidate the cache on every
// producer run, since it is a non-ignored untracked file.
function gitFixture(prefix: string): GitFixture {
  const base = fixture(prefix);
  const repository = path.join(base.directory, "repo");
  fs.mkdirSync(repository);
  execFileSync("git", ["init", "--quiet"], { cwd: repository });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: repository });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: repository });
  fs.writeFileSync(path.join(repository, "source.txt"), "content");
  execFileSync("git", ["add", "source.txt"], { cwd: repository });
  execFileSync("git", ["commit", "-m", "init", "--quiet"], { cwd: repository });
  return { ...base, repository, counter: path.join(base.directory, "runs.count") };
}

test("verify returns a minimal semantic success result for an explicit aggregate argv", async () => {
  const { directory, producer, config } = fixture("suzukuri-verify-success-");
  const lines: string[] = [];
  const originalLog = console.log;
  fs.writeFileSync(
    producer,
    "if (process.argv.slice(2).join(' ') !== 'format:check lint typecheck test governance:actions test:package') process.exit(2);\n" +
      "console.log('verbose format/lint/typecheck/test/governance/package output'.repeat(10000));\n",
  );
  fs.writeFileSync(
    config,
    JSON.stringify({
      schemaVersion: 1,
      commands: {
        verify: [
          process.execPath,
          producer,
          "format:check",
          "lint",
          "typecheck",
          "test",
          "governance:actions",
          "test:package",
        ],
      },
    }),
  );
  console.log = (line: string) => lines.push(line);
  try {
    const exitCode = await runCli(["verify", "--config", config]);
    assert.equal(exitCode, 0);
    assert.deepEqual(JSON.parse(lines[0] ?? "{}"), {
      completeness: "complete",
      status: "passed",
      version: VERIFY_RESULT_SCHEMA_VERSION,
    });
  } finally {
    console.log = originalLog;
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("verify identifies an observable failing stage and bounds its diagnostic", async () => {
  const { directory, producer, config } = fixture("suzukuri-verify-failure-");
  const lines: string[] = [];
  const originalLog = console.log;
  fs.writeFileSync(
    producer,
    "console.log('x'.repeat(100000) + '\\n> package@1.0.0 lint /repo\\n> eslint .\\nError: stage: lint'); process.exitCode = 1;\n",
  );
  fs.writeFileSync(
    config,
    JSON.stringify({ schemaVersion: 1, commands: { verify: [process.execPath, producer, "lint"] } }),
  );
  console.log = (line: string) => lines.push(line);
  try {
    const exitCode = await runVerifyCommand({ positionals: [], options: { config } });
    assert.equal(exitCode, 1);
    const result = JSON.parse(lines[0] ?? "{}") as Record<string, unknown>;
    assert.equal(result.status, "failed");
    assert.equal(result.stage, "lint");
    assert.equal(result.completeness, "complete");
    assert.equal(result.truncated, true);
    assert.ok(Buffer.byteLength(String(result.diagnostic), "utf8") <= 8 * 1024);
    assert.equal(isVerifyResult(result), true);
  } finally {
    console.log = originalLog;
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("verify emits an explicit incomplete unknown-stage result when evidence is insufficient", async () => {
  const { directory, producer, config } = fixture("suzukuri-verify-unknown-");
  const lines: string[] = [];
  const originalLog = console.log;
  fs.writeFileSync(producer, "process.stderr.write('opaque failure\\n'); process.exitCode = 1;\n");
  fs.writeFileSync(config, JSON.stringify({ schemaVersion: 1, commands: { verify: [process.execPath, producer] } }));
  console.log = (line: string) => lines.push(line);
  try {
    const exitCode = await runVerifyCommand({ positionals: [], options: { config } });
    assert.equal(exitCode, 1);
    const result = JSON.parse(lines[0] ?? "{}") as Record<string, unknown>;
    assert.equal(result.stage, "unknown");
    assert.equal(result.completeness, "incomplete");
    assert.equal(validateVerifyResult(result).valid, true);
  } finally {
    console.log = originalLog;
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("verify preserves a producer signal outcome", async () => {
  const { directory, producer, config } = fixture("suzukuri-verify-signal-");
  const lines: string[] = [];
  const originalLog = console.log;
  fs.writeFileSync(producer, "process.kill(process.pid, 'SIGTERM');\n");
  fs.writeFileSync(config, JSON.stringify({ schemaVersion: 1, commands: { verify: [process.execPath, producer] } }));
  console.log = (line: string) => lines.push(line);
  try {
    const exitCode = await runVerifyCommand({ positionals: [], options: { config } });
    const result = JSON.parse(lines[0] ?? "{}") as Record<string, unknown>;
    assert.equal(exitCode, 128 + 15);
    assert.equal(result.signal, "SIGTERM");
    assert.equal(result.exitCode, null);
  } finally {
    console.log = originalLog;
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("verify with ordered steps stops at the first failed step and reports its declared name as the stage", async () => {
  const { directory, config } = fixture("suzukuri-verify-steps-failure-");
  const okScript = path.join(directory, "ok.mjs");
  const brokenScript = path.join(directory, "broken.mjs");
  const neverRunsScript = path.join(directory, "never-runs.mjs");
  const marker = path.join(directory, "never-runs.marker");
  const lines: string[] = [];
  const originalLog = console.log;
  fs.writeFileSync(okScript, "process.exitCode = 0;\n");
  fs.writeFileSync(brokenScript, "console.error('boom'); process.exitCode = 1;\n");
  fs.writeFileSync(neverRunsScript, `import fs from "node:fs"; fs.writeFileSync(${JSON.stringify(marker)}, "ran");\n`);
  fs.writeFileSync(
    config,
    JSON.stringify({
      schemaVersion: 1,
      commands: {
        verify: {
          steps: [
            { name: "lint", argv: [process.execPath, okScript] },
            { name: "typecheck", argv: [process.execPath, brokenScript] },
            { name: "test", argv: [process.execPath, neverRunsScript] },
          ],
        },
      },
    }),
  );
  console.log = (line: string) => lines.push(line);
  try {
    const exitCode = await runVerifyCommand({ positionals: [], options: { config } });
    assert.equal(exitCode, 1);
    const result = JSON.parse(lines[0] ?? "{}") as Record<string, unknown>;
    assert.equal(result.status, "failed");
    assert.equal(result.stage, "typecheck");
    assert.equal(result.completeness, "complete");
    assert.equal(fs.existsSync(marker), false, "a step after the failing one must never run");
  } finally {
    console.log = originalLog;
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("verify with ordered steps reports success once every step passes", async () => {
  const { directory, config } = fixture("suzukuri-verify-steps-success-");
  const okScript = path.join(directory, "ok.mjs");
  const lines: string[] = [];
  const originalLog = console.log;
  fs.writeFileSync(okScript, "process.exitCode = 0;\n");
  fs.writeFileSync(
    config,
    JSON.stringify({
      schemaVersion: 1,
      commands: {
        verify: {
          steps: [
            { name: "lint", argv: [process.execPath, okScript] },
            { name: "test", argv: [process.execPath, okScript] },
          ],
        },
      },
    }),
  );
  console.log = (line: string) => lines.push(line);
  try {
    const exitCode = await runVerifyCommand({ positionals: [], options: { config } });
    assert.equal(exitCode, 0);
    assert.deepEqual(JSON.parse(lines[0] ?? "{}"), {
      completeness: "complete",
      status: "passed",
      version: VERIFY_RESULT_SCHEMA_VERSION,
    });
  } finally {
    console.log = originalLog;
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("a second unchanged verify invocation returns the prior bounded result without spawning the producer again", async () => {
  const { repository, directory, producer, config, counter } = gitFixture("suzukuri-verify-cache-hit-");
  const originalCwd = process.cwd();
  const originalLog = console.log;
  const lines: string[] = [];
  fs.writeFileSync(producer, `import fs from "node:fs"; fs.appendFileSync(${JSON.stringify(counter)}, "x");\n`);
  fs.writeFileSync(config, JSON.stringify({ schemaVersion: 1, commands: { verify: [process.execPath, producer] } }));
  console.log = (line: string) => lines.push(line);
  try {
    process.chdir(repository);
    const first = await runVerifyCommand({ positionals: [], options: { config } });
    assert.equal(first, 0);
    assert.equal(fs.readFileSync(counter, "utf8"), "x");

    const second = await runVerifyCommand({ positionals: [], options: { config } });
    assert.equal(second, 0);
    assert.equal(fs.readFileSync(counter, "utf8"), "x", "producer must not run a second time on a cache hit");

    const secondResult = JSON.parse(lines[1] ?? "{}") as Record<string, unknown>;
    assert.equal(secondResult.reused, true);
    assert.equal(secondResult.status, "passed");
  } finally {
    process.chdir(originalCwd);
    console.log = originalLog;
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("a cached failed verify result is reused while content is unchanged", async () => {
  const { repository, directory, producer, config, counter } = gitFixture("suzukuri-verify-cache-failure-");
  const originalCwd = process.cwd();
  const originalLog = console.log;
  const lines: string[] = [];
  fs.writeFileSync(
    producer,
    `import fs from "node:fs"; fs.appendFileSync(${JSON.stringify(counter)}, "x"); console.log("> pkg@1 lint /repo"); process.exitCode = 1;\n`,
  );
  fs.writeFileSync(config, JSON.stringify({ schemaVersion: 1, commands: { verify: [process.execPath, producer] } }));
  console.log = (line: string) => lines.push(line);
  try {
    process.chdir(repository);
    const first = await runVerifyCommand({ positionals: [], options: { config } });
    assert.equal(first, 1);

    const second = await runVerifyCommand({ positionals: [], options: { config } });
    assert.equal(second, 1);
    assert.equal(fs.readFileSync(counter, "utf8"), "x", "producer must not run a second time on a cache hit");

    const secondResult = JSON.parse(lines[1] ?? "{}") as Record<string, unknown>;
    assert.equal(secondResult.reused, true);
    assert.equal(secondResult.status, "failed");
  } finally {
    process.chdir(originalCwd);
    console.log = originalLog;
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("an included byte change after a verify cache hit causes the producer to run again", async () => {
  const { repository, directory, producer, config, counter } = gitFixture("suzukuri-verify-cache-invalidate-");
  const originalCwd = process.cwd();
  const originalLog = console.log;
  console.log = () => {};
  fs.writeFileSync(producer, `import fs from "node:fs"; fs.appendFileSync(${JSON.stringify(counter)}, "x");\n`);
  fs.writeFileSync(config, JSON.stringify({ schemaVersion: 1, commands: { verify: [process.execPath, producer] } }));
  try {
    process.chdir(repository);
    await runVerifyCommand({ positionals: [], options: { config } });
    fs.writeFileSync(path.join(repository, "source.txt"), "changed");
    await runVerifyCommand({ positionals: [], options: { config } });
    assert.equal(fs.readFileSync(counter, "utf8"), "xx");
  } finally {
    process.chdir(originalCwd);
    console.log = originalLog;
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
